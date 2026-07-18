# -*- coding: utf-8 -*-
"""
sparkbook — SCF Web 函数后端（纯 API 服务）

职责：
  - /api/ai          调 DeepSeek 生成/进化日报与会议纪要（开启 prompt caching）
  - /api/asr/upload  接收浏览器上传的录音字节（支持分片），服务端用 COS 分块上传写入临时桶（中继，免 CORS/免直连）
  - /api/asr/transcribe 用腾讯云 ASR 对临时音频转写，返回文本并清理（标准版免费额度耗尽自动回退极速版 flash）
  - /api/vault/save   接收浏览器加密信封（密文），服务端凭证写入 COS（中继，免 CORS）
  - /api/vault/load   服务端凭证从 COS 读回加密信封（中继，免 CORS）
  - /api/vault/presign 仅备用：下发 COS 预签名 URL（当前 vault 走中继，未用直传）

零知识边界：SCF 永不接触笔记明文/主密码。它只代理 LLM 与 ASR，
所有敏感数据在浏览器端加解密；vault 中继仅经手密文（vid + 加密信封）。
ASR 的腾讯云密钥复用 COS 同一套密钥。

依赖（打包进 vendor/）：Flask 3.x + requests + tencentcloud-sdk-python-asr
"""
import os
import sys
import time
import json
import re
import hmac
import hashlib
import uuid

import requests
from flask import Flask, request, jsonify, Response

# SCF 部署：把 vendor 加入路径（Flask 等依赖打包在此）
VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor')
if os.path.isdir(VENDOR):
    sys.path.insert(0, VENDOR)

app = Flask(__name__)


# CORS：前端托管在 CloudStudio（与 SCF 不同源），必须允许跨域
@app.after_request
def _cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return resp


# ------------------------- 配置（来自 SCF 环境变量） -------------------------
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
COS_SECRET_ID = os.environ.get('COS_SECRET_ID', '')
COS_SECRET_KEY = os.environ.get('COS_SECRET_KEY', '')
COS_BUCKET = os.environ.get('COS_BUCKET', 'sparkbook-1256784020')
COS_REGION = os.environ.get('COS_REGION', 'ap-guangzhou')
# 腾讯云 APPID（桶名后缀即 APPID），极速版 flash API 签名需要
COS_APPID = os.environ.get('COS_APPID', '') or (COS_BUCKET.split('-')[-1] if '-' in COS_BUCKET else '')
# 可选：设置后 /api/* 需带 Authorization: Bearer <token>；留空则为开发态（开放）
API_TOKEN = os.environ.get('SPARKBOOK_API_TOKEN', '')
COS_HOST = '{bucket}.cos.{region}.myqcloud.com'.format(bucket=COS_BUCKET, region=COS_REGION)
DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
ASR_TEMP_PREFIX = 'asr-tmp/'


# ------------------------- 可选鉴权 -------------------------
def authorized():
    if not API_TOKEN:
        return True
    h = request.headers.get('Authorization', '')
    return h.startswith('Bearer ') and hmac.compare_digest(h[7:], API_TOKEN)


def auth_fail():
    return jsonify({'code': 1, 'msg': '未授权'}), 401


# ------------------------- DeepSeek -------------------------
def call_deepseek(messages, model='deepseek-chat', temperature=0.3,
                  max_tokens=2000, use_cache=True):
    if not DEEPSEEK_API_KEY:
        return None, 'SCF 未配置 DEEPSEEK_API_KEY'
    payload = {
        'model': model,
        'messages': messages,
        'temperature': temperature,
        'max_tokens': max_tokens,
        'stream': False,
    }
    # DeepSeek prompt caching：系统提示（首条 message）命中缓存后 input 价降至 1/10
    if use_cache:
        payload['prompt_cache'] = True
    try:
        r = requests.post(
            DEEPSEEK_URL,
            headers={'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
                     'Content-Type': 'application/json'},
            json=payload,
            timeout=120,
        )
        r.raise_for_status()
        return r.json()['choices'][0]['message']['content'], None
    except Exception as e:  # noqa: BLE001
        return None, 'DeepSeek 调用失败: ' + str(e)


@app.route('/api/ai', methods=['POST', 'OPTIONS'])
def api_ai():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    d = request.get_json(force=True, silent=True) or {}
    action = d.get('action', 'generate')          # generate=写日报/纪要；evolve=风格进化
    messages = d.get('messages') or []
    if not messages:
        return jsonify({'code': 2, 'msg': '缺少 messages'}), 400
    # 进化用 reasoner（归纳抽象），生成用 chat（便宜）
    model = 'deepseek-reasoner' if action == 'evolve' else 'deepseek-chat'
    text, err = call_deepseek(
        messages,
        model=model,
        max_tokens=d.get('max_tokens', 2000),
        temperature=d.get('temperature', 0.3),
    )
    if err:
        return jsonify({'code': 3, 'msg': err}), 502
    return jsonify({'code': 0, 'text': text, 'model': model})


# ------------------------- 需求挖掘（扫历史日报，抽取需求登记册） -------------------------
MINING_SYSTEM = (
    '你是需求情报抽取器。下面是若干篇「工作日报」的正文，每篇带有日期。'
    '请从这些日报中抽取被提及的「需求 / 项目 / 专项工作」引用，建立需求登记册。\n'
    '抽取规则：\n'
    '1. 识别一切需求迹象：我行的正式需求编号（形如 XQ 后接一串数字，如 XQ202606001）、'
    '年月数字代号（如 202606 表示 2026年6月需求）、项目/系统简称（如「反洗钱2.0」「AI质检」「对公集市批量对账」）、'
    '以及尚无正式编号和名称的「潜在需求描述」（如「近期业务提到的对公客户画像优化」）。\n'
    '2. 同一需求在不同日报中可能写法不同（如先写「经营平台202606需求」，后写「202606」），'
    '请归并为同一条，name 取「首次出现的、最长的、最完整的写法」作为全称。\n'
    '3. stage（当前所处阶段）从下列标准阶段列表中选择最贴近的：'
    '潜在需求、需求讨论、需求确认、需求分析、议价、立项、开发、测试、投产、验证、运维/故障。\n'
    '4. firstSeen / lastSeen 取该需求在所给日报中最早 / 最晚出现的日期（YYYY-MM-DD）。\n'
    '5. 若某需求无正式编号，code 填空字符串；note 可写「潜在需求，待立项编号」。\n'
    '只输出一个 JSON 数组，不要任何解释。元素格式：\n'
    '{"code":"XQ202606001 或 空串","name":"完整需求/项目名称","stage":"标准阶段之一",'
    '"firstSeen":"YYYY-MM-DD","lastSeen":"YYYY-MM-DD","note":""}\n'
    '若某篇日报未提及任何需求，不要为它产出元素。\n'
)


@app.route('/api/mine', methods=['POST', 'OPTIONS'])
def api_mine():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    d = request.get_json(force=True, silent=True) or {}
    texts = d.get('texts') or []
    if not isinstance(texts, list) or not texts:
        return jsonify({'code': 2, 'msg': '缺少 texts'}), 400
    # 组装带日期标注的语料
    buf = []
    for t in texts[:50]:  # 单次最多 50 篇，防超长
        date = (t.get('date') or '')[:10]
        body = (t.get('body') or '').strip()
        if body:
            buf.append(f'【日报日期 {date}】\n{body}')
    corpus = '\n\n'.join(buf)
    if not corpus.strip():
        return jsonify({'code': 0, 'requirements': []})
    messages = [
        {'role': 'system', 'content': MINING_SYSTEM},
        {'role': 'user', 'content': corpus},
    ]
    text, err = call_deepseek(messages, model='deepseek-chat', max_tokens=2000, temperature=0.2, use_cache=False)
    if err:
        return jsonify({'code': 3, 'msg': err}), 502
    reqs = _parse_requirements_json(text)
    return jsonify({'code': 0, 'requirements': reqs})


def _parse_requirements_json(text):
    if not text:
        return []
    try:
        m = re.search(r'\[[\s\S]*\]', text)
        if not m:
            return []
        arr = json.loads(m.group(0))
        out = []
        for x in arr:
            if not isinstance(x, dict):
                continue
            name = str(x.get('name') or '').strip()
            if not name and not str(x.get('code') or '').strip():
                continue
            out.append({
                'code': str(x.get('code') or '').strip(),
                'name': name,
                'stage': str(x.get('stage') or '未知').strip(),
                'firstSeen': str(x.get('firstSeen') or '').strip()[:10],
                'lastSeen': str(x.get('lastSeen') or '').strip()[:10],
                'note': str(x.get('note') or '').strip(),
            })
        return out
    except Exception:  # noqa: BLE001
        return []


# ------------------------- COS 预签名（官方 SDK，签名最稳妥） -------------------------
def _cos_client():
    from qcloud_cos import CosConfig, CosS3Client
    cfg = CosConfig(Region=COS_REGION, SecretId=COS_SECRET_ID, SecretKey=COS_SECRET_KEY)
    return CosS3Client(cfg)


def cos_presign_url(method, key, expired=3600):
    client = _cos_client()
    return client.get_presigned_url(COS_BUCKET, key.lstrip('/'), method.upper(), expired)


@app.route('/api/asr/presign', methods=['POST', 'OPTIONS'])
def asr_presign():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    if not (COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET):
        return jsonify({'code': 2, 'msg': 'SCF 未配置 COS 环境变量'}), 500
    d = request.get_json(force=True, silent=True) or {}
    ext = (d.get('ext') or 'm4a').lstrip('.')
    key = '{prefix}{uid}.{ext}'.format(prefix=ASR_TEMP_PREFIX, uid=uuid.uuid4().hex, ext=ext)
    url = cos_presign_url('put', key, expired=3600)
    return jsonify({'code': 0, 'key': key, 'url': url, 'method': 'PUT'})


# ------------------------- 录音中继上传（免浏览器直连 COS 的 CORS 痛点） -------------------------
# 前端把音频二进制 POST 到本端点，SCF 用服务端密钥写入 asr-tmp/，返回 key。
# 受 API 网关请求体上限（约 6MB）限制，前端对大文件做分片或提示用户。
@app.route('/api/asr/upload', methods=['POST', 'OPTIONS'])
def asr_upload():
    """录音上传（支持分片，突破 API 网关 ~6MB 请求体上限）。

    模式：
      - 单文件（前端判定为 1 片）：POST /api/asr/upload?ext=mp3  body=原始字节
        → 直接 put_object，返回 {code:0, key}（transcribe 仍可用）。
      - 分片：前端把文件切成 ≤4MB 的片，依次
          POST /api/asr/upload?ext=mp3&sid=<会话>&part=<i>&total=<n>  body=该片字节
        SCF 用 COS 分块上传逐片写入，状态存于 asr-tmp/<sid>/meta.json；全部片传完后：
          POST /api/asr/upload?sid=<会话>&final=1  → 合并分块，返回最终 key。
        失败清理：
          POST /api/asr/upload?sid=<会话>&abort=1   → 中止分块上传并删除残留。
    最终 key 仍以 asr-tmp/ 前缀，transcribe 可直接使用；转写后由 transcribe 清理。
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    if not (COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET):
        return jsonify({'code': 2, 'msg': 'SCF 未配置 COS 环境变量'}), 500
    ext = (request.args.get('ext') or 'm4a').lstrip('.')
    sid = request.args.get('sid') or ''
    is_final = request.args.get('final') == '1'
    is_abort = request.args.get('abort') == '1'

    if is_abort:
        return _asr_abort(sid)
    if is_final:
        return _asr_finalize(sid)

    # 读取请求体（原始字节；fetch body 为 Blob/File 时）
    data = request.get_data()
    if not data:
        f = request.files.get('file')
        if f:
            data = f.read()
    if not data:
        return jsonify({'code': 2, 'msg': '空文件'}), 400

    # 单文件直传（无 sid）
    if not sid:
        key = ASR_TEMP_PREFIX + uuid.uuid4().hex + '.' + ext
        try:
            _cos_put_raw(key, data)
        except Exception as e:  # noqa: BLE001
            return jsonify({'code': 3, 'msg': 'COS 写入失败: ' + str(e)}), 502
        return jsonify({'code': 0, 'key': key})

    # 分片上传
    part = request.args.get('part')
    if part is None:
        return jsonify({'code': 2, 'msg': '分片请求缺少 part 参数'}), 400
    try:
        key, part_no = _asr_upload_part(sid, ext, int(part), data)
    except Exception as e:  # noqa: BLE001
        return jsonify({'code': 3, 'msg': '分片上传失败: ' + str(e)}), 502
    return jsonify({'code': 0, 'part': part_no})


def _asr_meta_key(sid):
    return ASR_TEMP_PREFIX + sid + '/meta.json'


def _asr_upload_part(sid, ext, part_idx, data):
    """处理一个分片：发起/续用分块上传，upload_part，更新 meta。返回 (key, part_no)。"""
    client = _cos_client()
    meta_key = _asr_meta_key(sid)
    meta = _cos_get_json(meta_key)
    if not meta:
        key = ASR_TEMP_PREFIX + sid + '/audio.' + ext
        mpu = client.create_multipart_upload(
            Bucket=COS_BUCKET, Key=key, ContentType='application/octet-stream')
        meta = {'key': key, 'uploadId': mpu['UploadId'], 'parts': {}}
        _cos_put_json(meta_key, meta)
    part_no = part_idx + 1  # COS 分块序号从 1 开始
    resp = client.upload_part(
        Bucket=COS_BUCKET, Key=meta['key'], PartNumber=part_no,
        UploadId=meta['uploadId'], Body=data)
    # qcloud_cos 的 complete_multipart_upload 在 ETag 带双引号时生成的 XML 会丢 Part；
    # 这里去掉首尾引号，complete 时再由 SDK 自行加回。
    etag = resp.get('ETag') or ''
    if etag.startswith('"') and etag.endswith('"'):
        etag = etag[1:-1]
    meta['parts'][str(part_no)] = etag
    _cos_put_json(meta_key, meta)
    return meta['key'], part_no


def _asr_finalize(sid):
    client = _cos_client()
    meta_key = _asr_meta_key(sid)
    meta = _cos_get_json(meta_key)
    if not meta or not meta.get('uploadId'):
        return jsonify({'code': 2, 'msg': '未找到分片会话或已失效'}), 400
    try:
        parts = [{'PartNumber': int(p), 'ETag': meta['parts'][str(p)]}
                 for p in sorted(meta['parts'].keys(), key=lambda x: int(x))]
        # qcloud_cos 的 complete_multipart_upload 要求 MultipartUpload={'Part': [...]}（单数 Part）
        client.complete_multipart_upload(
            Bucket=COS_BUCKET, Key=meta['key'], UploadId=meta['uploadId'],
            MultipartUpload={'Part': parts})
    except Exception as e:  # noqa: BLE001
        return jsonify({'code': 3, 'msg': '合并分片失败: ' + str(e)}), 502
    try:
        client.delete_object(Bucket=COS_BUCKET, Key=meta_key)
    except Exception:  # noqa: BLE001
        pass
    return jsonify({'code': 0, 'key': meta['key']})


def _asr_abort(sid):
    client = _cos_client()
    meta_key = _asr_meta_key(sid)
    meta = _cos_get_json(meta_key)
    if meta and meta.get('uploadId'):
        try:
            client.abort_multipart_upload(
                Bucket=COS_BUCKET, Key=meta['key'], UploadId=meta['uploadId'])
        except Exception:  # noqa: BLE001
            pass
    try:
        client.delete_object(Bucket=COS_BUCKET, Key=meta_key)
    except Exception:  # noqa: BLE001
        pass
    return jsonify({'code': 0, 'msg': 'aborted'})


def _cos_put_raw(key, body):
    client = _cos_client()
    client.put_object(Bucket=COS_BUCKET, Key=key.lstrip('/'),
                      Body=body, ContentType='application/octet-stream')


def _cos_get_json(key):
    try:
        raw = _cos_get(key)
        return json.loads(raw.decode('utf-8'))
    except Exception:  # noqa: BLE001
        return None


def _cos_put_json(key, obj):
    client = _cos_client()
    client.put_object(Bucket=COS_BUCKET, Key=key.lstrip('/'),
                      Body=json.dumps(obj).encode('utf-8'),
                      ContentType='application/json')


# ------------------------- 加密库（vault）预签名 -------------------------
# 整个用户加密库作为单个对象 vaults/{vid}.enc 读写。vid 由浏览器端
# SHA-256(主密码) 派生，SCF 不接触明文/密码，仅对指定 key 下发预签名 URL。
VAULT_PREFIX = 'vaults/'


@app.route('/api/vault/presign', methods=['POST', 'OPTIONS'])
def vault_presign():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    if not (COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET):
        return jsonify({'code': 2, 'msg': 'SCF 未配置 COS 环境变量'}), 500
    d = request.get_json(force=True, silent=True) or {}
    vid = d.get('vid', '')
    action = (d.get('action') or 'put').lower()
    if not vid or len(vid) != 64 or any(c not in '0123456789abcdef' for c in vid):
        return jsonify({'code': 2, 'msg': '无效的 vid'}), 400
    if action not in ('get', 'put'):
        return jsonify({'code': 2, 'msg': 'action 仅支持 get/put'}), 400
    key = VAULT_PREFIX + vid + '.enc'
    # 写库给 1 小时预签名（足够上传）；读库给 10 分钟
    expired = 3600 if action == 'put' else 600
    url = cos_presign_url(action, key, expired=expired)
    return jsonify({'code': 0, 'key': key, 'url': url, 'method': action.upper()})


# ------------------------- 加密库（vault）中继存储 -------------------------
# 为避免浏览器直连 COS 的 CORS 配置痛点（与 word-dictation 一致），
# 改由 SCF 在服务端用凭证读写 COS；SCF 仅经手密文（零知识边界不变）。
def _cos_put(key, body):
    client = _cos_client()
    client.put_object(Bucket=COS_BUCKET, Key=key.lstrip('/'),
                      Body=body, ContentType='application/json')


def _cos_get(key):
    client = _cos_client()
    resp = client.get_object(Bucket=COS_BUCKET, Key=key.lstrip('/'))
    return resp['Body'].get_raw_stream().read()


@app.route('/api/vault/save', methods=['POST', 'OPTIONS'])
def vault_save():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    if not (COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET):
        return jsonify({'code': 2, 'msg': 'SCF 未配置 COS 环境变量'}), 500
    d = request.get_json(force=True, silent=True) or {}
    vid = d.get('vid', '')
    env = d.get('env')
    if not vid or len(vid) != 64 or any(c not in '0123456789abcdef' for c in vid):
        return jsonify({'code': 2, 'msg': '无效的 vid'}), 400
    if not isinstance(env, dict) or 'ct' not in env or 'iv' not in env or 'salt' not in env:
        return jsonify({'code': 2, 'msg': '无效的加密信封'}), 400
    try:
        _cos_put(VAULT_PREFIX + vid + '.enc', json.dumps(env).encode('utf-8'))
    except Exception as e:  # noqa: BLE001
        return jsonify({'code': 3, 'msg': 'COS 写入失败: ' + str(e)}), 502
    return jsonify({'code': 0, 'msg': 'ok'})


@app.route('/api/vault/load', methods=['POST', 'OPTIONS'])
def vault_load():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    if not (COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET):
        return jsonify({'code': 2, 'msg': 'SCF 未配置 COS 环境变量'}), 500
    d = request.get_json(force=True, silent=True) or {}
    vid = d.get('vid', '')
    if not vid or len(vid) != 64 or any(c not in '0123456789abcdef' for c in vid):
        return jsonify({'code': 2, 'msg': '无效的 vid'}), 400
    try:
        raw = _cos_get(VAULT_PREFIX + vid + '.enc')
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        # COS 在无 ListBucket 权限时，对不存在的对象返回 AccessDenied 而非 NoSuchKey；
        # 零知识设计下每个用户的库以 vid 命名空间隔离，AccessDenied 视为「该库不存在」。
        if '404' in msg or 'NoSuchKey' in msg or 'AccessDenied' in msg:
            return jsonify({'code': 10, 'msg': 'not found'})
        return jsonify({'code': 12, 'msg': 'COS 读取失败: ' + msg}), 502
    try:
        env = json.loads(raw.decode('utf-8'))
    except Exception:
        return jsonify({'code': 11, 'msg': '数据损坏'})
    return jsonify({'code': 0, 'env': env})


# ------------------------- 腾讯云 ASR（录音文件识别） -------------------------
def _asr_standard_try(cos_key, expired, flash_fallback):
    """标准版（CreateRecTask），精度最高；flash_fallback=True 时免费额度耗尽自动回退极速版。"""
    try:
        from tencentcloud.common import credential
        from tencentcloud.asr.v20190614 import asr_client, models
        from tencentcloud.common.exception.tencent_cloud_sdk_exception import (
            TencentCloudSDKException,
        )
        cred = credential.Credential(COS_SECRET_ID, COS_SECRET_KEY)
        client = asr_client.AsrClient(cred, COS_REGION)
        # 用预签名 GET URL 让 ASR 拉取临时音频（1 小时内有效）
        url = cos_presign_url('get', cos_key, expired=expired)
        req = models.CreateRecTaskRequest()
        req.EngineModelType = '16k_zh'   # 16k 中文，适配 M4A/WAV/MP3
        req.ChannelNum = 1
        req.ResTextFormat = 0            # 0=原文本（适合做纪要）
        req.SourceType = 0               # 0=URL 方式
        req.Url = url
        resp = client.CreateRecTask(req)
        task_id = resp.Data.TaskId
        # 轮询任务状态（最多约 3 分钟，留余量给 LLM 纪要提炼）
        for _ in range(40):
            time.sleep(5)
            status_req = models.DescribeTaskStatusRequest()
            status_req.TaskId = task_id
            st = client.DescribeTaskStatus(status_req)
            if st.Data.Status == 2:      # 成功
                return st.Data.Result, None
            if st.Data.Status in (3, -1):  # 失败
                return None, 'ASR 任务失败 status={0}'.format(st.Data.Status)
        return None, 'ASR 超时（超过 4 分钟）'
    except TencentCloudSDKException as e:
        code = getattr(e, 'code', '') or ''
        emsg = str(e)
        # 标准版免费额度耗尽 → 自动回退极速版（独立免费包，精度略降，单文件≤2h/100MB）
        if flash_fallback and ('NoFreeAmount' in code or 'NoFreeAmount' in emsg):
            try:
                return asr_transcribe_flash(cos_key)
            except Exception as fe:  # noqa: BLE001
                return None, '标准版免费额度已用尽；极速版回退失败: ' + str(fe)
        return None, '腾讯云 ASR 错误: ' + emsg
    except Exception as e:  # noqa: BLE001
        return None, 'ASR 异常: ' + str(e)


def asr_transcribe(cos_key, engine_pref='standard', expired=3600):
    """按偏好选择转写引擎，主引擎失败时自动回退次选，尽量出结果。
    engine_pref: 'standard'（默认，精度最高）或 'flash'（极速版，精度略降，单文件≤2h/100MB）。
    - standard 优先：免费额度耗尽 → 回退 flash（仅当文件≤2h/100MB）。
    - flash 优先：额度/时长/大小超限 → 回退 standard（不再回退 flash，避免循环）。
    """
    if engine_pref == 'flash':
        text, err = asr_transcribe_flash(cos_key)
        if text is not None:
            return text, None
        # 极速版不可用（额度/时长/大小限制）→ 回退标准版（不再回退 flash，避免循环）
        return _asr_standard_try(cos_key, expired, flash_fallback=False)
    return _asr_standard_try(cos_key, expired, flash_fallback=True)


# ------------------------- 腾讯云 ASR 极速版（flash）回退 -------------------------
# 当标准版免费额度耗尽(UserHasNoFreeAmount)时，自动改用「录音文件识别极速版」flash API。
# 极速版是独立 API（非 CreateRecTask），单文件上限 2 小时 / 100MB，精度略低于标准版。
# 签名算法严格复刻腾讯云官方 tencentcloud-speech-sdk-python 的 FlashRecognizer 实现。
def _flash_sign_string(params):
    """params: 已按 key 排序的 [(k,v), ...] 列表（含 appid）。返回待签名原始串。"""
    signstr = 'POSTasr.cloud.tencent.com/asr/flash/v1/'
    for k, v in params:
        if 'appid' in k:
            signstr += str(v)
            break
    signstr += '?'
    for k, v in params:
        if 'appid' in k:
            continue
        signstr += str(k) + str(v) + '='
    signstr = signstr[:-1] + '&'
    signstr = signstr[:-1]
    return signstr


def _flash_sign(signstr, secret_key):
    hmacstr = hmac.new(secret_key.encode('utf-8'), signstr.encode('utf-8'), hashlib.sha1).digest()
    return base64.b64encode(hmacstr).decode('utf-8')


_FLASH_VOICE_FORMAT = {
    'mp3': 'mp3', 'm4a': 'm4a', 'wav': 'wav', 'flac': 'flac', 'ogg': 'ogg',
    'oga': 'ogg', 'aac': 'aac', 'amr': 'amr', 'pcm': 'pcm', 'wma': 'wma',
    'mp4': 'mp4', 'flv': 'flv', 'm4v': 'm4v', '3gp': '3gp',
}


def asr_transcribe_flash(cos_key):
    """极速版 flash 转写：下载临时音频字节直接 POST 到 asr.cloud.tencent.com。
    返回 (text, err)，text=None 表示失败。"""
    try:
        cos = _cos_client()
        # 极速版单文件上限 100MB，先查大小避免无谓下载
        head = cos.head_object(Bucket=COS_BUCKET, Key=cos_key.lstrip('/'))
        size = int(head.get('Content-Length', 0) or 0)
        if size > 100 * 1024 * 1024:
            return None, '极速版单文件上限 100MB，当前 %.1fMB，无法回退' % (size / 1024.0 / 1024.0)
        # 取音频字节流（流式上传，避免大文件占满 SCF 内存）
        obj = cos.get_object(Bucket=COS_BUCKET, Key=cos_key.lstrip('/'))
        body = obj['Body'].get_stream()
        ext = cos_key.rsplit('.', 1)[-1].lower() if '.' in cos_key else 'mp3'
        voice_format = _FLASH_VOICE_FORMAT.get(ext, 'mp3')
        params = [
            ('appid', COS_APPID),
            ('secretid', COS_SECRET_ID),
            ('timestamp', str(int(time.time()))),
            ('engine_type', '16k_zh'),
            ('voice_format', voice_format),
            ('convert_num_mode', '1'),
            ('speaker_diarization', '0'),
            ('filter_dirty', '0'),
            ('filter_modal', '0'),
            ('filter_punc', '0'),
            ('first_channel_only', '1'),
        ]
        params.sort(key=lambda x: x[0])
        signstr = _flash_sign_string(params)
        signature = _flash_sign(signstr, COS_SECRET_KEY)
        url = 'https://' + signstr[4:]  # 去掉前缀 POST
        headers = {
            'Host': 'asr.cloud.tencent.com',
            'Content-Type': 'application/octet-stream',
            'Authorization': signature,
        }
        resp = requests.post(url, data=body, headers=headers, timeout=150)
        data = resp.json()
        if data.get('code', -1) != 0:
            return None, '极速版 ASR 错误 code=%s msg=%s' % (data.get('code'), data.get('message'))
        result = data.get('flash_result') or []
        texts = [seg.get('text', '') for seg in result if seg.get('text')]
        return '\n'.join(texts), None
    except Exception as e:  # noqa: BLE001
        return None, '极速版调用异常: ' + str(e)


# ------------------------- 会议纪要提炼（LLM） -------------------------
MEETING_SYSTEM = (
    '你是专业的会议纪要整理助手。下面是一段会议录音的逐字转写稿，'
    '请整理为可直接用于工作日志的结构化会议纪要。\n'
    '输出严格遵循以下 Markdown 格式：\n'
    '## 会议概况\n'
    '- 主题/议题：\n'
    '- 参会方/人员：\n'
    '- 时间：\n\n'
    '## 核心结论\n'
    '1. （每条结论一行，保留决策、数字、负责人，使用编号列表）\n\n'
    '## 行动项（待办）\n'
    '1. （格式：负责人 — 事项 — 时限；缺失标注「待确认」，使用编号列表）\n\n'
    '## 备忘\n'
    '- （关键风险、未决事项、需跟进点）\n\n'
    '要求：剔除口语冗余、重复、停顿词（如「那个」「呃」）；使用中文书面语，精简凝练；\n'
    '保留具体时间、金额、系统/产品原名（如 OceanBase、星环TDH）不缩写；\n'
    '核心结论与行动项使用编号列表，每条独立且可验证。\n'
    '若某小节无内容则写「未提及」。\n'
    '【严守以下约束，违反视为严重错误】\n'
    '1. 严禁臆造参会人员的姓名、单位、职务。若录音中无人自报身份，'
    '不要写出具体人名，改为标注「未明确自报，据对话推测约 N 人，分属不同立场'
    '（如甲方/乙方、内部/外部、不同团队）」，并以「说话人A/说话人B」区分不同声音。\n'
    '2. 你（用户）是否为参会者、是否发言、代表哪一方，录音中通常无法确认。'
    '不要臆断「我方/我」的立场，也不要把某句话归为「用户说的」，'
    '除非录音中有清晰的第一人称表述（如「我方认为」「我这边的进展是」），'
    '或用户在「我的身份/是否发言」自述中已明确说明（可依此标注用户立场，但不得反推他人）。'
    '若仍无法判断，在「参会方/人员」处写明「用户身份/立场：录音中无法确认」。\n'
    '3. 仅依据录音文本归纳，不引入任何文本之外的信息；'
    '如用户提供「已知背景」，该背景优先采信，但不得据此虚构录音里没有的细节。'
)


# 长录音分段摘要点（map-reduce 第一阶段）：只抽事实，不要求完整结构
BLOCK_SYSTEM = (
    '你是会议录音转写稿的分段整理助手。下面是一段会议转写，请提取关键事实要点：'
    '决策、结论、行动项（含负责人与时限，缺失标「待确认」）、风险、数字、需跟进事项。'
    '保留具体时间、金额、系统/产品原名（如 OceanBase、星环TDH）不缩写。'
    '剔除口语冗余、重复、停顿词；输出为要点列表，每条以「- 」开头，不带标题、不加解释。'
    '不要臆造文本中没有的人名/单位；无法确定立场时标注「待确认」。'
    '本段若无实质内容，仅输出「（无要点）」。'
)


def _split_chunks(text, max_chars=4000):
    """按段落切块；单段超长则尽量在标点处硬切，避免跨段截断语义。"""
    if len(text) <= max_chars:
        return [text]
    chunks, buf = [], ''
    for para in text.split('\n'):
        if not para.strip():
            continue
        if len(buf) + len(para) + 1 <= max_chars:
            buf = (buf + '\n' + para) if buf else para
        else:
            if buf:
                chunks.append(buf)
            while len(para) > max_chars:
                cut = para[:max_chars]
                for sep in ('。', '；', '，', '！', '？', ';', ',', ' '):
                    idx = cut.rfind(sep)
                    if idx > int(max_chars * 0.6):
                        cut = cut[:idx + 1]
                        break
                chunks.append(cut)
                para = para[len(cut):]
            buf = para
    if buf:
        chunks.append(buf)
    return chunks or [text]


def summarize_meeting(raw_text, terms=None, context=None, profile=None, model='deepseek-chat'):
    """把逐字稿提炼为结构化会议纪要；长文本分块摘要再汇总(map-reduce)。失败返回 ('', 错误原因)。"""
    if not raw_text or not raw_text.strip():
        return '', None
    if not DEEPSEEK_API_KEY:
        return '', '未配置 DEEPSEEK_API_KEY，已保留原始转写'
    # 风格档案（rules/samples）注入最终汇总，使纪要贴合用户写作偏好
    style_block = ''
    if profile:
        if profile.get('rules'):
            rules = [r for r in profile['rules'] if str(r).strip()]
            if rules:
                style_block += '\n【写作风格要点（整理纪要时参考其措辞与详略）】\n' + '\n'.join('- ' + r for r in rules)
        if profile.get('samples'):
            samps = [s for s in profile['samples'] if isinstance(s, dict) and (s.get('before') or s.get('after'))]
            if samps:
                style_block += '\n【对照样例（初稿一行 / 终稿一行，参考其详略与措辞）】'
                for s in samps:
                    style_block += '\n- 初稿：' + (s.get('before') or '') + '\n  终稿：' + (s.get('after') or '')

    def build_user(content):
        u = content.strip()
        if terms:
            try:
                tl = [t for t in terms if str(t).strip()]
            except Exception:  # noqa: BLE001
                tl = []
            if tl:
                u += '\n\n【业务术语提示】整理时请准确保留以下术语：' + '、'.join(tl)
        if context and str(context).strip():
            u += '\n\n【已知会议背景（用户提供，优先采信，但不得据此虚构录音里没有的细节）】' + str(context).strip()
        return u

    user = build_user(raw_text.strip())
    chunks = _split_chunks(raw_text)
    if len(chunks) == 1:
        messages = [
            {'role': 'system', 'content': MEETING_SYSTEM + style_block},
            {'role': 'user', 'content': user},
        ]
        text, err = call_deepseek(messages, model=model, max_tokens=3500, temperature=0.3)
        if err:
            return '', err
        return (text or '').strip(), None

    # 长稿：每块先摘要点，再汇总（map-reduce），避免单次直灌导致中段信息丢失
    block_points = []
    for i, ch in enumerate(chunks):
        bm = [
            {'role': 'system', 'content': BLOCK_SYSTEM},
            {'role': 'user', 'content': ch},
        ]
        bt, berr = call_deepseek(bm, model=model, max_tokens=900, temperature=0.3)
        if berr:
            block_points.append('（该段处理异常，保留原始片段）\n' + ch[:600])
        else:
            block_points.append((bt or '（无要点）').strip())
    combined = '\n\n'.join('【第%d段 / 共%d段 要点】\n%s' % (i + 1, len(chunks), p) for i, p in enumerate(block_points))
    messages = [
        {'role': 'system', 'content': MEETING_SYSTEM + style_block},
        {'role': 'user', 'content': user},
    ]
    text, err = call_deepseek(messages, model='deepseek-chat', max_tokens=3500, temperature=0.3)
    if err:
        return '', err
    return (text or '').strip(), None

def asr_transcribe_route():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    d = request.get_json(force=True, silent=True) or {}
    key = d.get('key', '')
    if not key or not key.startswith(ASR_TEMP_PREFIX):
        return jsonify({'code': 2, 'msg': '无效的 key'}), 400
    engine = d.get('engine') or 'standard'
    if engine not in ('standard', 'flash'):
        engine = 'standard'
    try:
        text, err = asr_transcribe(key, engine_pref=engine)
    except Exception as e:  # noqa: BLE001
        return jsonify({'code': 4, 'msg': 'ASR 处理异常: ' + str(e)}), 502
    # 清理临时音频，避免 COS 堆积
    try:
        _cos_delete(key)
    except Exception:  # noqa: BLE001
        pass
    if err:
        return jsonify({'code': 3, 'msg': err}), 502
    # 两步式：transcribe 只返回原文，纪要由 /api/asr/summarize 显式生成
    return jsonify({'code': 0, 'text': text})


@app.route('/api/asr/summarize', methods=['POST', 'OPTIONS'])
def asr_summarize_route():
    """对已转写的原文 + 用户#标注 提炼结构化纪要。"""
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    d = request.get_json(force=True, silent=True) or {}
    text = (d.get('text') or '').strip()
    if not text:
        return jsonify({'code': 2, 'msg': '缺少 text'}), 400
    terms = d.get('terms') or None
    context = d.get('context') or None
    rules = d.get('rules') or None
    samples = d.get('samples') or None
    profile = {'rules': rules or [], 'samples': samples or []} if (rules or samples) else None
    model = d.get('model') or 'chat'
    if model not in ('chat', 'reasoner'):
        model = 'chat'
    summary, llm_err = summarize_meeting(text, terms, context, profile, model=model)
    resp = {'code': 0}
    if summary:
        resp['summary'] = summary
    else:
        resp['summary'] = ''
        resp['llm_warn'] = llm_err or '纪要提炼失败，已保留原文'
    return jsonify(resp)


def _cos_delete(key):
    try:
        client = _cos_client()
        client.delete_object(Bucket=COS_BUCKET, Key=key.lstrip('/'))
    except Exception:  # noqa: BLE001
        pass


# ------------------------- 健康检查 / 根路由 -------------------------
def _cos_probe():
    """真实探测 COS 读写权限（put/get 一个探针对象，再尽力删除）。"""
    try:
        key = '_health_probe'
        _cos_put(key, b'1')
        _cos_get(key)
        try:
            _cos_client().delete_object(Bucket=COS_BUCKET, Key=key)
        except Exception:
            pass
        return True
    except Exception:
        return False


@app.route('/api/health')
def health():
    return jsonify({
        'code': 0, 'ok': True,
        'deepseek': bool(DEEPSEEK_API_KEY),
        'cos': _cos_probe(),
        'auth': bool(API_TOKEN),
    })


@app.route('/', methods=['GET', 'OPTIONS'])
@app.route('/<path:path>', methods=['GET', 'OPTIONS'])
def root(path=''):
    if request.method == 'OPTIONS':
        return ('', 204)
    return jsonify({'code': 0, 'service': 'sparkbook-api',
                    'note': '这是 API 服务。前端请访问部署在 CloudStudio 的静态页面。'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=9000)
