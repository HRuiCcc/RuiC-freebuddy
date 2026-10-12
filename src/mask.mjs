// 演示模式：把账号标识的中间部分换成 ****（保留首尾，仍然一眼能认出是哪个账号）。
//
// 只作用于「发给面板的那份 JSON」，磁盘上的备份、meta.json、凭据缓存一概不动 ——
// 关掉开关（settings.json 里 maskAccounts 置 false）立刻恢复原样。
// 录视频前打开它，就不用在画面上逐处打马赛克了。

const STARS = '****';
/** 短于这个长度就整体打码（一两个字的名字保留首尾等于没遮） */
const TINY = 4;

export function maskMiddle(s) {
  const t = String(s == null ? '' : s);
  if (!t) return t;
  if (t.length < TINY) return STARS;
  return t.charAt(0) + STARS + t.charAt(t.length - 1);
}

// 手机号按国内习惯留前 3 后 4；不做格式校验，认长度就够。
export function maskPhone(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return t;
  if (t.length >= 11) return t.slice(0, 3) + STARS + t.slice(-4);
  return maskMiddle(t);
}

// 邮箱只遮 @ 前面的部分，域名留着
export function maskEmail(s) {
  const t = String(s == null ? '' : s);
  const at = t.indexOf('@');
  if (at <= 0) return maskMiddle(t);
  return STARS + t.slice(at);
}

/** 按字段类型打码；null / 空值原样返回，免得多出一堆空 **** */
export function maskValue(s, kind = 'name') {
  if (s == null || s === '') return s;
  switch (kind) {
    case 'phone':
      return maskPhone(s);
    case 'email':
      return maskEmail(s);
    case 'uid':
      return STARS;
    // 「账号标识」类：名字通常是中文昵称，但也有不少账号昵称本身就是手机号，
    // 那种按手机号的习惯遮（134****5678）比按名字遮更好认。
    case 'ident':
      return /^\d{11,}$/.test(String(s).trim()) ? maskPhone(s) : maskMiddle(s);
    default:
      return maskMiddle(s);
  }
}

/**
 * 一个账号对象 → 打码后的副本（原对象不动）。
 * ⚠️ **uid 必须原样保留** —— 面板拿它当主键（切换/删除/设主账号/签到/改备注都靠它），
 * 遮了这些操作就全废。uid 在界面上本来也不单独展示（只在没有名字时兜底截前 8 位显示）。
 */
export function maskAccount(a) {
  if (!a || typeof a !== 'object') return a;
  return {
    ...a,
    nickname: maskValue(a.nickname, 'ident'),
    note: maskValue(a.note, 'ident'),
    phone: maskValue(a.phone, 'phone'),
    uin: maskValue(a.uin, 'ident'),
  };
}

/**
 * 一批账号一起打码，并保证「显示名不撞车」。
 *
 * 账号名常是手机号，遮成 `134****5678` 后两个号可能只差中间几位、遮完一模一样；
 * 面板上出现两张同名卡片会让人以为搞错了。这里按需加露位数（临时放宽该条的遮法），
 * 直到彼此不同 —— **只在撞车时放宽，正常账号仍是最小暴露**。
 *
 * 返回与入参同序、等长的数组。
 */
export function maskAccounts(list) {
  const src = list || [];
  const labelOf = (a) => (a ? String(a.note || a.nickname || '').trim() : '');
  const out = src.map(maskAccount);

  // 显示名（备注优先，其次昵称）相同的先归一组：raw 相同的天然是一组，
  // 「遮完一样」的（只差中间几位的号）也归到一起 —— 这正是要在面板上区分开的情况。
  const groups = new Map();
  out.forEach((a, i) => {
    const raw = labelOf(src[i]);
    if (!raw) return;
    const shown = labelOf(a); // = maskValue(raw,'ident')
    if (!groups.has(shown)) groups.set(shown, []);
    groups.get(shown).push({ acc: a, raw });
  });

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const isDigits = /^\d{11,}$/.test(members[0].raw);
    const minLead = isDigits ? 3 : 1;
    const minTail = isDigits ? 4 : 1;
    const taken = new Set();
    // 原本的遮法先登记给「唯一」的那些条目，避免去重时抢了别人的名字
    for (const [shown, arr] of groups) if (arr.length === 1) taken.add(shown);
    for (const { acc, raw } of members) {
      let done = false;
      for (let lead = minLead; lead <= raw.length && !done; lead++) {
        for (let tail = minTail; tail <= raw.length && !done; tail++) {
          if (lead + tail > raw.length) continue;
          const c = raw.slice(0, lead) + STARS + raw.slice(-tail);
          if (taken.has(c)) continue;
          taken.add(c);
          if (acc.note && String(acc.note).trim() === raw) acc.note = c;
          else if (acc.nickname && String(acc.nickname).trim() === raw) acc.nickname = c;
          done = true;
        }
      }
      // 极端情况：短到怎么露都撞（例如两个 4 字名）——保持默认遮法，不再纠缠
    }
  }
  return out;
}

/** 由设置对象判断演示模式开没开 */
export function maskEnabled(settings) {
  return !!(settings && settings.maskAccounts);
}
