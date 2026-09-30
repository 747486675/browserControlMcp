import type { Locator } from 'playwright-core';
import { config } from '../config.js';
import { ToolError } from '../core/errors.js';
import { log } from '../log.js';
import type { Tab } from '../browser/tabs.js';
import { getRelay } from '../extension/relay.js';
import { audit } from './audit.js';

/**
 * 安全策略：在 click / type / press_key / select_option 真正执行之前检查。
 * - 敏感网站（网银、支付、邮箱等）：任何操作都要用户确认；
 * - 其他网站：只有"危险动作"（提交、支付、删除、输入密码等）要确认，信任的网站免确认；
 * - 确认弹窗由浏览器插件弹出，AI 无法绕过；被拒绝时抛出 ACTION_DENIED。
 * 判定基于元素文字和属性，是尽力而为的规则，所以敏感网站一律确认作为兜底。
 */

export type GuardAction = 'click' | 'type' | 'press_key' | 'select_option';

export interface GuardInput {
  action: GuardAction;
  tab: Tab;
  locator?: Locator;
  value?: string;
  submit?: boolean;
  key?: string;
}

interface ElementInfo {
  tag: string;
  type: string;
  text: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  inForm: boolean;
  formMethod: string;
  isSubmit: boolean;
  btnText: string;
}

const RISKY_WORDS =
  /(提交|发送|发布|发表|回复|确认|购买|结算|支付|付款|下单|删除|移除|清空|转账|提现|注销|退出登录|授权|绑定|解绑|充值|捐赠|submit|send|post\b|publish|reply|confirm|pay\b|buy|purchase|checkout|place order|order now|delete|remove|erase|transfer|withdraw|authori[sz]e|sign out|log ?out|unsubscribe|donate)/i;
const SECRET_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year']);
const SECRET_HINT = /(passw|pwd|card|cvv|cvc|otp|pin\b|验证码|卡号|密码|安全码|口令)/i;

function describeElement(el: Element): ElementInfo {
  const e = el as HTMLInputElement;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const form = e.form || el.closest('form');
  const btn = el.closest('button,[role=button],a,input[type=submit],input[type=button]') as HTMLElement | null;
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    tag,
    type,
    text: clean((el as HTMLElement).innerText || e.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt')),
    name: el.getAttribute('name') || '',
    id: el.id || '',
    autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
    placeholder: el.getAttribute('placeholder') || '',
    inForm: !!form,
    formMethod: form ? (form.getAttribute('method') || 'get').toLowerCase() : '',
    isSubmit: (tag === 'button' && (type === '' || type === 'submit') && !!form) || (tag === 'input' && (type === 'submit' || type === 'image')),
    btnText: btn ? clean(btn.innerText || (btn as HTMLInputElement).value || btn.getAttribute('aria-label')) : '',
  };
}

function isSecretField(i: ElementInfo): boolean {
  return i.type === 'password' || SECRET_AUTOCOMPLETE.has(i.autocomplete) || SECRET_HINT.test(`${i.name} ${i.id} ${i.placeholder}`);
}

export function matchHost(host: string, list: string[]): boolean {
  host = host.toLowerCase();
  return list.some((d) => {
    d = String(d).trim().toLowerCase();
    return !!d && (host === d || host.endsWith('.' + d));
  });
}

let policyCache: { at: number; sensitive: string[]; trusted: string[] } | null = null;
async function getPolicy() {
  if (policyCache && Date.now() - policyCache.at < 10_000) return policyCache;
  const p = await getRelay().callExtension('policy.get', []);
  policyCache = { at: Date.now(), sensitive: p?.sensitive ?? [], trusted: p?.trusted ?? [] };
  return policyCache;
}

/** 判断动作是否危险，返回原因；不危险返回 null */
function riskOf(input: GuardInput, info: ElementInfo | null): string | null {
  switch (input.action) {
    case 'click': {
      if (!info) return null;
      const label = info.btnText || info.text;
      if (RISKY_WORDS.test(label)) return `按钮文字「${label}」看起来会提交/支付/删除`;
      if (info.isSubmit && info.formMethod === 'post') return '这是一个会提交数据的表单按钮';
      return null;
    }
    case 'type': {
      if (info && isSecretField(info)) return '这是密码/验证码/银行卡类输入框';
      if (input.submit && info?.inForm && info.formMethod === 'post') return '输入后会回车提交表单';
      return null;
    }
    case 'press_key': {
      if (!/enter/i.test(input.key || '')) return null;
      if (info && isSecretField(info)) return '在密码/验证码输入框里按回车会提交';
      if (info?.inForm && info.formMethod === 'post') return '按回车会提交表单';
      return null;
    }
    default:
      return null;
  }
}

function maskValue(input: GuardInput, info: ElementInfo | null): string | undefined {
  if (input.value === undefined) return input.key;
  if (info && isSecretField(info)) return '•'.repeat(Math.min(input.value.length, 8)) || '(空)';
  return input.value.length > 100 ? input.value.slice(0, 100) + '…' : input.value;
}

export async function guard(input: GuardInput): Promise<void> {
  const page = input.tab.page;
  const url = page.url();
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }

  let info: ElementInfo | null = null;
  try {
    if (input.locator) info = await input.locator.evaluate(describeElement, undefined, { timeout: 2_000 });
    else if (input.action === 'press_key') {
      const focused = page.locator('*:focus').first();
      if (await focused.count()) info = await focused.evaluate(describeElement, undefined, { timeout: 2_000 });
    }
  } catch (e) {
    log.debug('读取元素信息失败', e);
  }

  const target = info ? `${info.tag}${info.type ? `[${info.type}]` : ''} ${info.btnText || info.text || info.name || info.placeholder}`.trim() : input.key;
  const base = { action: input.action, url, host, target, value: maskValue(input, info) };

  if (!config.safety || config.mode !== 'extension') {
    audit({ ...base, decision: 'allowed' });
    return;
  }

  const policy = await getPolicy();
  const sensitive = matchHost(host, policy.sensitive);
  let reason = sensitive ? '这是敏感网站（网银/支付/邮箱/账号安全等），所有操作都需要你确认' : riskOf(input, info);
  if (reason && !sensitive && matchHost(host, policy.trusted)) {
    audit({ ...base, risk: reason, decision: 'allowed-trusted' });
    return;
  }
  if (!reason) {
    audit({ ...base, decision: 'allowed' });
    return;
  }

  log.info(`请求用户确认：${input.action} ${host} ${target}（${reason}）`);
  let answer: string;
  try {
    answer = await getRelay().callExtension(
      'ui.confirm',
      [{ host, url, action: input.action, target, value: base.value, reason, sensitive, timeoutMs: config.confirmTimeoutMs }],
      config.confirmTimeoutMs + 10_000,
    );
  } catch (e) {
    audit({ ...base, risk: reason, decision: 'denied-error' });
    throw new ToolError('ACTION_DENIED', `无法向用户确认该操作：${(e as Error).message}`, { beforeDispatch: true });
  }
  if (answer === 'trust') policyCache = null;
  audit({ ...base, risk: reason, decision: answer === 'allow' || answer === 'trust' ? `confirmed-${answer}` : 'denied' });
  if (answer !== 'allow' && answer !== 'trust') {
    throw new ToolError('ACTION_DENIED', `用户拒绝了该操作（${reason}）`, { beforeDispatch: true });
  }
}
