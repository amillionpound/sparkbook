#!/usr/bin/env python3
"""
Deploy to Tencent Cloud SCF (Serverless Cloud Function).
Called by GitHub Actions workflow (or manually: `python deploy_scf.py`).

Reused across projects — each repo has a .scf-deploy.json config:
  {
    "function_name": "sparkbook-api",
    "namespace": "default",
    "region": "ap-guangzhou",
    "files": ["app.py", "scf_bootstrap", "requirements.txt"],
    "deps": ["flask>=3.0", "Werkzeug>=3.0", "Jinja2>=3.1", "requests>=2.31", "tencentcloud-sdk-python-asr"],
    "runtime": "Python3.10"
  }

Required env vars (from GitHub Secrets, NOT runtime):
  TENCENT_SECRET_ID
  TENCENT_SECRET_KEY
"""
import base64
import json
import os
import stat
import subprocess
import sys
import zipfile

from tencentcloud.common import credential
from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
from tencentcloud.scf.v20180416 import scf_client
from tencentcloud.scf.v20180416 import models as scf_models


def load_config():
    """Load deploy config from .scf-deploy.json, fall back to env vars."""
    config_path = ".scf-deploy.json"
    cfg = {
        "function_name": os.environ.get("SCF_FUNCTION_NAME", ""),
        "namespace": "default",
        "region": "ap-guangzhou",
        "files": ["app.py", "scf_bootstrap", "requirements.txt"],
        "deps": [],
    }
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))

    if not cfg["function_name"]:
        print("ERROR: function_name not set. Create .scf-deploy.json or set SCF_FUNCTION_NAME env var.")
        sys.exit(1)
    return cfg


def install_deps(deps, vendor_dir="vendor"):
    """Install Python dependencies into vendor_dir for bundling."""
    if not deps:
        return
    if os.path.exists(vendor_dir):
        import shutil
        shutil.rmtree(vendor_dir)
    os.makedirs(vendor_dir)
    print("Installing dependencies: " + ", ".join(deps))
    subprocess.run(
        [sys.executable, "-m", "pip", "install"] + deps + ["--target", vendor_dir],
        check=True,
        capture_output=True,
    )
    print("  Dependencies installed to {}/".format(vendor_dir))


def get_function_info(client, cfg, label=""):
    try:
        req = scf_models.GetFunctionRequest()
        req.FunctionName = cfg["function_name"]
        req.Namespace = cfg.get("namespace", "default")
        resp = client.GetFunction(req)
        print("--- Function Info {} ---".format(label))
        print("  Handler: {}".format(resp.Handler))
        print("  Runtime: {}".format(resp.Runtime))
        print("  Type: {}".format(resp.Type))
        print("  Status: {}".format(resp.Status))
        print("  CodeSize: {}".format(resp.CodeSize))
    except Exception as e:  # noqa: BLE001
        print("  GetFunction failed: {}".format(e))


def list_triggers(client, cfg):
    try:
        req = scf_models.ListTriggersRequest()
        req.FunctionName = cfg["function_name"]
        req.Namespace = cfg.get("namespace", "default")
        resp = client.ListTriggers(req)
        print("--- Triggers ---")
        if not resp.Triggers:
            print("  No triggers found")
        for t in resp.Triggers:
            print("  Type: {} | Name: {} | Qualifier: {} | Enable: {}".format(
                t.Type, t.TriggerName, getattr(t, "Qualifier", "N/A"), t.Enable))
    except Exception as e:  # noqa: BLE001
        print("  ListTriggers failed: {}".format(e))


def main():
    secret_id = os.environ.get("TENCENT_SECRET_ID")
    secret_key = os.environ.get("TENCENT_SECRET_KEY")

    if not secret_id or not secret_key:
        print("ERROR: TENCENT_SECRET_ID and TENCENT_SECRET_KEY must be set")
        sys.exit(1)

    cfg = load_config()
    install_deps(cfg.get("deps", []))

    zip_path = "deploy.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in cfg["files"]:
            if os.path.exists(f):
                if f == "scf_bootstrap":
                    with open(f, "rb") as fh:
                        data = fh.read()
                    info = zipfile.ZipInfo(f)
                    info.external_attr = (
                        (stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP
                         | stat.S_IROTH | stat.S_IXOTH) << 16)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    z.writestr(info, data)
                    print("  Added: {} (chmod 755)".format(f))
                else:
                    z.write(f)
                    print("  Added: {}".format(f))
            else:
                print("  WARNING: {} not found, skipping".format(f))

        vendor_dir = "vendor"
        if os.path.isdir(vendor_dir):
            dep_count = 0
            for root, _, files in os.walk(vendor_dir):
                for fname in files:
                    full_path = os.path.join(root, fname)
                    arc_path = os.path.relpath(full_path, ".")
                    z.write(full_path, arc_path)
                    dep_count += 1
            print("  Added: {} dependency files from {}/".format(dep_count, vendor_dir))

    with open(zip_path, "rb") as f:
        zip_b64 = base64.b64encode(f.read()).decode("utf-8")

    print("Deploy package: {} bytes".format(os.path.getsize(zip_path)))
    print("Function: {} (ns={}, region={})".format(
        cfg["function_name"], cfg["namespace"], cfg["region"]))

    try:
        cred = credential.Credential(secret_id, secret_key)
        client = scf_client.ScfClient(cred, cfg["region"])

        get_function_info(client, cfg, "(BEFORE update)")
        list_triggers(client, cfg)

        # Update function code (HTTP/Web Function: do NOT set Handler)
        req = scf_models.UpdateFunctionCodeRequest()
        req.FunctionName = cfg["function_name"]
        req.Namespace = cfg["namespace"]
        req.ZipFile = zip_b64
        resp = client.UpdateFunctionCode(req)
        print("DEPLOY SUCCESS: RequestId={}".format(resp.RequestId))

        import time
        def wait_active(label, max_retries=12):
            for i in range(max_retries):
                time.sleep(5)
                try:
                    check_req = scf_models.GetFunctionRequest()
                    check_req.FunctionName = cfg["function_name"]
                    check_req.Namespace = cfg["namespace"]
                    check_resp = client.GetFunction(check_req)
                    print("  {} check ({}/{}): {}".format(
                        label, i + 1, max_retries, check_resp.Status))
                    if check_resp.Status == "Active":
                        return True
                except Exception:  # noqa: BLE001
                    pass
            return False

        wait_active("post-code")

        desired_runtime = cfg.get("runtime")
        if desired_runtime:
            try:
                cfg_req = scf_models.UpdateFunctionConfigurationRequest()
                cfg_req.FunctionName = cfg["function_name"]
                cfg_req.Namespace = cfg["namespace"]
                cfg_req.Runtime = desired_runtime
                cfg_resp = client.UpdateFunctionConfiguration(cfg_req)
                print("Runtime updated to {}: RequestId={}".format(
                    desired_runtime, cfg_resp.RequestId))
                wait_active("post-runtime")
            except Exception as e:  # noqa: BLE001
                print("Runtime update skipped: {}".format(e))

        get_function_info(client, cfg, "(AFTER update)")
        list_triggers(client, cfg)

    except TencentCloudSDKException as e:
        print("DEPLOY FAILED: {}".format(e))
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print("ERROR: {}".format(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
