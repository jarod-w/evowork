---
name: email-draft
description: 写可以复制的邮件草稿，包含收件人、主题、正文和要对方做的事。只生成草稿，不发送邮件。用户要写信、回复邮件或起草邮件时使用。
---

# email-draft —— 邮件草稿

只产出一份可以复制的草稿。不连接邮箱，不发送，不保存密码。

## 怎么用

```bash
node container_tools/mark_artifact.mjs \
  --operation-kind create --expected-output-count 1 --output-format md \
  --title "邮件草稿" --path "<绝对路径>/邮件草稿.md"

python3 container_tools/check.py --content mail.json --out "<绝对路径>/邮件草稿.md"
```

## 内容 JSON

```json
{
  "to": ["财务部"],
  "cc": [],
  "subject": "请在周五前确认三季度预算",
  "body": "附件是预算表。请看合计行，有问题直接回复。",
  "ask": "确认预算金额，或列出要改的行"
}
```

`to`、`subject`、`body`、`ask` 都不能空。`ask` 是你要对方做的那一件事，写在草稿末尾，避免信只有背景没有请求。

出现 `send`、`smtp`、`deliver`、`password`、`token` 这些字段时检查器直接拒绝。用户说「发出去」时，把草稿交给用户自己发。
