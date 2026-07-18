# -*- coding: utf-8 -*-
"""
sparkbook — SCF Web 函数后端（纯 API 服务）

职责：
  - /api/ai          调 DeepSeek 生成/进化日报与会议纪要（开启 prompt caching）
  - /api/asr/presign 下发 COS 预签名 PUT URL，供浏览器直传 M4A（不暴露密钥）
  - /api/asr/transcribe 用腾讯云 ASR 对临时音频转写，返回文本并清理
  - /api/vault/save   接收浏览器加密信封（密文），服务端凭证写入 COS（中继，免 CORS）
  - /api/vault/load   服务端凭证从 COS 读回加密信封（中继，免 CORS）
  - /api/vault/presign 仅 ASR 录音上传用（浏览器直传大文件仍需桶 CORS）

零知识边界：SCF 永不接触笔记明文/主密码。它只代理 LLM 与 ASR，
所有敏感数据在浏览器端加解密；vault 中继仅经手密文（vid + 加密信封）。
ASR 的腾讯云密钥复用 COS 同一套密钥。

依赖（打包进 vendor/）：Flask 3.x + requests + tencentcloud-sdk-python-asr
"""
import os
import sys
import time
import json
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
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    if not (COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET):
        return jsonify({'code': 2, 'msg': 'SCF 未配置 COS 环境变量'}), 500
    data = request.get_data()  # 原始字节（fetch body 为 Blob/File 时）
    if not data:
        f = request.files.get('file')
        if f:
            data = f.read()
    if not data:
        return jsonify({'code': 2, 'msg': '空文件'}), 400
    ext = (request.args.get('ext') or 'm4a').lstrip('.')
    key = ASR_TEMP_PREFIX + uuid.uuid4().hex + '.' + ext
    try:
        _cos_put_raw(key, data)
    except Exception as e:  # noqa: BLE001
        return jsonify({'code': 3, 'msg': 'COS 写入失败: ' + str(e)}), 502
    return jsonify({'code': 0, 'key': key})


def _cos_put_raw(key, body):
    client = _cos_client()
    client.put_object(Bucket=COS_BUCKET, Key=key.lstrip('/'),
                      Body=body, ContentType='application/octet-stream')


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
def asr_transcribe(cos_key, expired=3600):
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
        return None, '腾讯云 ASR 错误: ' + str(e)
    except Exception as e:  # noqa: BLE001
        return None, 'ASR 异常: ' + str(e)


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
    '- （每条结论一行，保留决策、数字、负责人）\n\n'
    '## 行动项（待办）\n'
    '- （格式：负责人 — 事项 — 时限；未提及标注「待确认」）\n\n'
    '## 备忘\n'
    '- （关键风险、未决事项、需跟进点）\n\n'
    '要求：剔除口语冗余、重复、停顿词（如「那个」「呃」）；使用中文书面语，精简凝练；'
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


def summarize_meeting(raw_text, terms=None, context=None):
    """把逐字稿提炼为结构化会议纪要；失败返回 ('', 错误原因)。"""
    if not raw_text or not raw_text.strip():
        return '', None
    if not DEEPSEEK_API_KEY:
        return '', '未配置 DEEPSEEK_API_KEY，已保留原始转写'
    user = raw_text.strip()
    if terms:
        try:
            term_list = [t for t in terms if t and str(t).strip()]
        except Exception:  # noqa: BLE001
            term_list = []
        if term_list:
            user += '\n\n【业务术语提示】整理时请准确保留以下术语：' + '、'.join(term_list)
    if context and str(context).strip():
        ctx = str(context).strip()
        user += '\n\n【已知会议背景（用户提供，优先采信，但不得据此虚构录音中没有的细节）】' + ctx
    messages = [
        {'role': 'system', 'content': MEETING_SYSTEM},
        {'role': 'user', 'content': user},
    ]
    text, err = call_deepseek(messages, model='deepseek-chat', max_tokens=2000, temperature=0.3)
    if err:
        return '', err
    return (text or '').strip(), None


@app.route('/api/asr/transcribe', methods=['POST', 'OPTIONS'])
def asr_transcribe_route():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    d = request.get_json(force=True, silent=True) or {}
    key = d.get('key', '')
    if not key or not key.startswith(ASR_TEMP_PREFIX):
        return jsonify({'code': 2, 'msg': '无效的 key'}), 400
    try:
        text, err = asr_transcribe(key)
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
    summary, llm_err = summarize_meeting(text, terms, context)
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
