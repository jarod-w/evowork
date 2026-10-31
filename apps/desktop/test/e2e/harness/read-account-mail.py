"""在服务器上只读查找本次授权 state 对应的验证信，不输出其他邮件。"""
import datetime
import email
import hashlib
import html
import imaplib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlparse, parse_qs

request = json.load(sys.stdin)
config = dict(line.split('=', 1) for line in Path('/etc/evowork-web.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
try:
    mailbox = imaplib.IMAP4_SSL('imap.qq.com', 993, timeout=20)
    mailbox.login(config['EVOWORK_SMTP_USER'], config['EVOWORK_SMTP_PASSWORD'])
    mailbox.select('INBOX', readonly=True)
    since = datetime.datetime.fromtimestamp(request['after'] / 1000, datetime.timezone.utc).strftime('%d-%b-%Y')
    status, found = mailbox.search(None, 'FROM', '"' + config['EVOWORK_SMTP_USER'] + '"', 'SINCE', since)
    result = {}
    for uid in reversed(found[0].split()[-20:]):
        status, content = mailbox.fetch(uid, '(BODY.PEEK[])')
        raw = next((item[1] for item in content if isinstance(item, tuple)), b'')
        message = email.message_from_bytes(raw)
        for part in message.walk():
            if part.get_content_type() not in ('text/plain', 'text/html'):
                continue
            text = (part.get_payload(decode=True) or b'').decode(part.get_content_charset() or 'utf-8', errors='replace')
            for url in re.findall(r"https?://[^\s<>\"']+", html.unescape(text)):
                parsed = urlparse(url)
                if (parsed.scheme + '://' + parsed.netloc == request['origin'] and parsed.path in ('/verify', '/reset') and parse_qs(parsed.query).get('state') == [request['state']]):
                    result = {'url': url, 'mailDigest': hashlib.sha256(raw).hexdigest()}
                    break
            if result:
                break
        if result:
            break
    mailbox.logout()
    print(json.dumps(result))
except Exception as error:
    print(json.dumps({'error': type(error).__name__}))
