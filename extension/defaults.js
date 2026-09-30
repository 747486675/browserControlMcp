// 默认设置。敏感网站：AI 在这些网站上的任何操作（点击、输入、按键、选择）都需要你确认。
// 匹配规则：主机名等于该项，或以 "." + 该项结尾。可在插件设置页修改。
export const DEFAULT_SENSITIVE = [
  // 银行
  'icbc.com.cn', 'ccb.com', 'boc.cn', 'abchina.com', 'bankcomm.com', 'cmbchina.com', 'psbc.com',
  'spdb.com.cn', 'cib.com.cn', 'cmbc.com.cn', 'citicbank.com', 'bank.pingan.com', 'cebbank.com', 'hxb.com.cn',
  'webank.com', 'mybank.cn',
  // 支付
  'alipay.com', 'pay.weixin.qq.com', 'paypal.com', 'unionpay.com', '95516.com', 'checkout.stripe.com', 'pay.jd.com',
  // 券商 / 理财
  'futunn.com', 'futuhk.com', 'itiger.com', 'htsc.com.cn', 'gtja.com', 'cicc.com', 'licaitong.qq.com', 'fund.eastmoney.com',
  // 邮箱
  'mail.google.com', 'mail.qq.com', 'exmail.qq.com', 'mail.163.com', 'mail.126.com', 'mail.sina.com.cn',
  'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com', 'mail.aliyun.com',
  // 账号安全
  'accounts.google.com', 'myaccount.google.com', 'account.microsoft.com', 'login.live.com', 'appleid.apple.com',
  'passport.alipay.com', 'aq.qq.com',
];

export const DEFAULT_PORT = 9230;
export const GROUP_TITLE = 'AI';
export const PROTOCOL_VERSION = 1;
