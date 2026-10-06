/** 原生 Helper 读取的目标语义；不接受模型声明的风险或许可。 */
export interface ComputerUseActionTarget {
  app: string;
  role: string;
  label: string;
  editable: boolean;
}
export type ComputerUseActionCategory =
  | 'local-edit'
  | 'navigation'
  | 'send'
  | 'delete'
  | 'payment'
  | 'appointment'
  | 'upload'
  | 'account'
  | 'install'
  | 'high-impact'
  | 'unknown'
  | 'captcha';
export interface ComputerUseActionRisk {
  category: ComputerUseActionCategory;
  title: string;
  confirmation: boolean;
  blocked: boolean;
}
const RULES: readonly [ComputerUseActionCategory, string, RegExp][] = [
  ['captcha', '验证码需要你手动处理', /captcha|验证码|人机验证|verify you are human/i],
  [
    'high-impact',
    '高影响提交',
    /报税|税务|医疗|处方|诉讼|法律|求职|应聘|tax|medical|prescription|legal|apply for job/i,
  ],
  [
    'payment',
    '付款或金融交易',
    /付款|支付|购买|订阅|转账|交易|pay\b|purchase|buy\b|subscribe|transfer|checkout/i,
  ],
  [
    'appointment',
    '创建、修改或取消预约',
    /预约|预订|取消会议|appointment|booking|reservation|schedule meeting/i,
  ],
  ['delete', '删除数据', /删除|移到废纸篓|清空|移除|delete|trash|erase|remove|clear all/i],
  ['upload', '上传文件', /上传|upload/i],
  [
    'account',
    '账号权限或敏感凭据',
    /权限|密钥|密码|银行卡|permission|access token|api key|password|credit card/i,
  ],
  ['install', '安装或修改安全设置', /安装|扩展|安全设置|install|extension|security setting/i],
  ['send', '发送或提交内容', /发送|提交|发布|分享|评论|send|submit|publish|share|post\b|comment/i],
];
/** 启发式仅用来说明风险；安全边界是「无法识别也确认」，不是关键词匹配的准确率。 */
export function assessComputerUseAction(
  name: string,
  args: Readonly<Record<string, unknown>>,
  target: ComputerUseActionTarget,
): ComputerUseActionRisk {
  const result = (category: ComputerUseActionCategory, title: string, confirmation = true) => ({
    category,
    title,
    confirmation,
    blocked: category === 'captcha',
  });
  for (const [category, title, expression] of RULES)
    if (expression.test(target.label)) return result(category, title);
  if (name === 'press_key' && ['Delete', 'Backspace', 'Meta+X'].includes(String(args.key)))
    return result('delete', '删除或剪切内容');
  if (name === 'press_key' && args.key === 'Enter') return result('send', '可能提交内容');
  if (name === 'type_text' && /[\r\n]/.test(String(args.text ?? '')))
    return result('send', '带换行输入可能提交内容');
  if (name === 'scroll' || name === 'select_text')
    return result('navigation', '移动视图或选择文本', false);
  if (
    name === 'press_key' &&
    [
      'Tab',
      'Shift+Tab',
      'Escape',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ].includes(String(args.key))
  )
    return result('navigation', '移动焦点或视图', false);
  if (
    target.app === 'com.apple.TextEdit' &&
    target.editable &&
    ['AXTextArea', 'AXTextField'].includes(target.role) &&
    ['set_value', 'paste', 'type_text'].includes(name)
  )
    return result('local-edit', '本地文本编辑', false);
  return result('unknown', '无法可靠判断用途的界面操作');
}
