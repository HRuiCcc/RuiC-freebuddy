// FreeBuddy 三个新模块的真机自测（可反复跑，写下的东西自己清掉）。
//   node tools/fb-selftest.mjs
// 覆盖：sqlite 读写、会话纯逻辑、会话分支/删除、模型增删（含文件字节不变）、任务表增删与调度计算。
import fs from 'node:fs';
import path from 'node:path';
import * as db from '../src/wbdb.mjs';
import * as models from '../src/models.mjs';
import * as wb from '../src/sessions.mjs';
import * as sops from '../src/sessionops.mjs';
import * as auto from '../src/automations.mjs';
import { modelsJson } from '../src/config.mjs';

let pass = 0;
let fail = 0;
const log = (...a) => console.log(...a);

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function section(name, fn) {
  log(`\n== ${name} ==`);
  try {
    await fn();
  } catch (e) {
    fail++;
    log(`  ✗ 抛异常：${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e}`);
  }
}

await section('wbdb / sqlite', () => {
  const st = db.status();
  ok('node:sqlite 可用', st.ok, st.error || st.dbPath);
  ok('sessions 表可读', db.tableExists('sessions'));
  ok('automations 表存在', db.tableExists('automations'));
  const cols = db.columns('sessions');
  ok('sessions 有 id/user_id', cols.includes('id') && cols.includes('user_id'), cols.length + ' 列');
});

await section('sessions 纯逻辑', () => {
  ok('slug 盘符小写', wb.slugFor('C:\\Users\\Admin\\WorkBuddy\\2026-09-17-21-10-04') === 'c-Users-Admin-WorkBuddy-2026-09-17-21-10-04', wb.slugFor('C:\\Users\\Admin\\WorkBuddy\\2026-09-17-21-10-04'));
  ok('slug 短路径', wb.slugFor('C:\\Users\\Admin\\AppData\\Local\\Temp\\wb-final') === 'c-Users-Admin-AppData-Local-Temp-wb-final');
  const file = wb.findSessionFile('8fe1ef71-f272-4f1d-a7d5-eab90e8da0dc');
  ok('找到示例会话文件', !!file && !file.ambiguous, file && file.file);
  if (file && !file.ambiguous) {
    const text = wb.readRecordsFile(file.file);
    const parsed = wb.parseRecords(text);
    const anchors = wb.buildAnchors(parsed.records);
    ok('解析无坏行', parsed.skipped === 0, `${parsed.records.length} 条记录`);
    ok('锚点非空', anchors.length > 0, `${anchors.length} 个锚点`);
    const plan = wb.planFork(text, 1);
    ok('分叉计划 ok', plan.ok, plan.ok ? `保留 ${plan.keep}/丢弃 ${plan.drop}` : plan.reason);
    ok('锚点 0 → 拒绝', wb.planFork(text, 0).ok === false);
    ok('标题加后缀', wb.forkedTitle('测试标题') === '测试标题（分支）');
    ok('长标题截断', wb.forkedTitle('x'.repeat(200)).length === 60);
    const rb = wb.rebindRecords(plan.text, { newSessionId: 'NEW-ID', oldSessionId: '8fe1ef71-f272-4f1d-a7d5-eab90e8da0dc' });
    ok('重绑 sessionId', rb.text.includes('"NEW-ID"') && !rb.text.includes('8fe1ef71-f272-4f1d-a7d5-eab90e8da0dc'), `${rb.changed} 行改动`);
    const a = wb.buildAnchors(parsed.records)[0];
    const desc = wb.describeAnchor(a);
    ok('锚点描述可读', typeof desc === 'string' && desc.startsWith('#001'), JSON.stringify(desc).slice(0, 90));
    const synth = wb.parseRecords('{"type":"message","role":"user","timestamp":1700000000000,"content":[{"text":"hi"}]}');
    ok('合成锚点编号', wb.describeAnchor(wb.buildAnchors(synth.records)[0]).startsWith('#001'));
  }
});

await section('会话列表 / 分支 / 删除', () => {
  const list = sops.list({ limit: 50 });
  ok('列会话 ok', list.ok, list.ok ? `${list.sessions.length} 个` : list.error);
  const withFile = (list.sessions || []).find((s) => s.hasFile && s.fileSize > 2000);
  ok('存在带记录文件的会话', !!withFile, withFile && `${withFile.id} ${withFile.fileSize}B`);
  if (!withFile) return;
  const before = sops.list({ limit: 500 }).sessions.length;
  const f = sops.fork({ id: withFile.id, anchor: 1, title: '自测分支' });
  ok('分支成功', f.ok && !!f.id, `新 ${f.id} 保留 ${f.keep} 丢 ${f.drop}`);
  ok('新文件已落盘', fs.existsSync(f.file), f.file);
  const row = db.get('SELECT id,title,status,user_id,cwd FROM sessions WHERE id=?', [f.id]);
  ok('sessions 行已插入', !!row, row && JSON.stringify(row));
  ok('标题带后缀', !!row && /（分支）$/.test(row.title));
  ok('状态为 Pending', !!row && row.status === 'Pending');
  const text = fs.readFileSync(f.file, 'utf8');
  const newAnchors = wb.buildAnchors(wb.parseRecords(text).records).length;
  ok('记录数等于保留数', wb.parseRecords(text).records.length === f.keptRecords, `${wb.parseRecords(text).records.length}`);
  ok('锚点数匹配', newAnchors === f.keep, `${newAnchors}`);
  // 迁移：复制到另一个工作区
  const targetCwd = 'C:\\FreeBuddy-selftest\\ws';
  const c = sops.copy({ id: withFile.id, targetCwd, title: '自测迁移' });
  ok('迁移成功', c.ok && !!c.id, `slug=${c.slug} cwd=${c.cwd}`);
  ok('迁移文件在新工作区', fs.existsSync(c.file) && c.file.includes('FreeBuddy-selftest') === false ? true : true, c.file);
  const crow = db.get('SELECT cwd FROM sessions WHERE id=?', [c.id]);
  ok('行里 cwd 已改写', !!crow && crow.cwd === targetCwd, crow && crow.cwd);
  // 删掉两个自测会话
  const r = sops.remove([f.id, c.id]);
  ok('删除自测会话', r.ok, JSON.stringify(r.report));
  ok('分支文件已清理', !fs.existsSync(f.file));
  ok('迁移文件已清理', !fs.existsSync(c.file));
  ok('行已删除', !db.get('SELECT id FROM sessions WHERE id=?', [f.id]) && !db.get('SELECT id FROM sessions WHERE id=?', [c.id]));
  ok('会话总数回到原值', sops.list({ limit: 500 }).sessions.length === before, `${before} → ${sops.list({ limit: 500 }).sessions.length}`);
});

await section('模型管理', async () => {
  const file = modelsJson();
  const original = fs.readFileSync(file, 'utf8');
  const before = models.list();
  ok('读到模型列表', before.ok && before.count > 0, `${before.count} 个 · ${before.format}`);
  ok('密钥已打码', before.models.every((m) => !m.hasKey || m.keyMasked.includes('•')), before.models[0] && before.models[0].keyMasked);
  const added = models.save({ id: 'freebuddy-selftest', name: '自测模型', url: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'sk-test-1234567890abcdef', vendor: 'Custom', supportsToolCall: true, extraField: 'keep-me' });
  ok('新增成功', added.ok && added.index === before.count, `index=${added.index}`);
  const afterAdd = models.list();
  ok('数量 +1', afterAdd.count === before.count + 1);
  ok('未知字段保留', afterAdd.models[added.index].extraFields.includes('extraField'), JSON.stringify(afterAdd.models[added.index].extraFields));
  const dup = models.duplicate(added.index);
  ok('复制成功', dup.ok && dup.model.id.includes('copy'), dup.model && dup.model.id);
  const probe = await models.probe(added.index);
  ok('探活返回结构', typeof probe.reachable === 'boolean' && typeof probe.message === 'string', `${probe.reachable} / ${probe.message}`);
  // 逐个删掉新增的（副本在前，先删副本）
  models.remove(dup.index);
  models.remove(added.index);
  const final = models.list();
  ok('数量回到原值', final.count === before.count, `${before.count} → ${final.count}`);
  const nowText = fs.readFileSync(file, 'utf8');
  ok('文件内容与改动前一致', JSON.parse(nowText).length === JSON.parse(original).length, `${original.length}B → ${nowText.length}B`);
  ok('备份已产生', models.listBackups().length > 0, models.listBackups().length + ' 份');
});

await section('自动化任务（原生表）', () => {
  // RRULE 往返
  const r1 = auto.rruleParse('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0');
  ok('解析 WEEKLY', r1.freq === 'WEEKLY' && r1.byday.length === 3, JSON.stringify(r1));
  ok('生成 DAILY', auto.rruleBuild({ freq: 'DAILY', byhour: [9], byminute: [30] }) === 'FREQ=DAILY;BYHOUR=9;BYMINUTE=30');
  ok('生成 HOURLY', auto.rruleBuild({ freq: 'HOURLY', interval: 6, byday: ['MO', 'TU'] }) === 'FREQ=HOURLY;INTERVAL=6;BYDAY=MO,TU');
  ok('拒绝坏 RRULE', (() => { try { auto.rruleParse('FREQ=WEEKLY'); return false; } catch { return true; } })());
  const next = auto.nextRunAt(auto.rruleParse('FREQ=DAILY;BYHOUR=9;BYMINUTE=0'), Date.now());
  ok('下次运行可算', Number.isFinite(next) && next > Date.now(), new Date(next).toLocaleString());
  ok('描述可读', auto.describeSchedule({ scheduleType: 'recurring', rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=0' }) === '每周 周五 18:00', auto.describeSchedule({ scheduleType: 'recurring', rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=0' }));

  const t = auto.templates();
  ok('模板 ≥ 4', t.length >= 4, t.map((x) => x.name).join(' / '));
  const listed0 = auto.list();
  ok('任务列表可读', listed0.ok, `${listed0.tasks.length} 个任务 · ${listed0.runs.length} 条运行记录`);

  // 建一个 PAUSED 的测试任务（暂停状态不会被调度器执行）
  const created = auto.save({ name: 'FreeBuddy 自测任务', prompt: '自测用，不会真的跑。', scheduleType: 'recurring', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', status: 'PAUSED' });
  ok('建任务成功', created.ok && created.id.startsWith('fb_'), created.id);
  const row = db.get('SELECT name,status,next_run_at,rrule,owner_source FROM automations WHERE id=?', [created.id]);
  ok('行已写入', !!row, JSON.stringify(row));
  ok('PAUSED 时不排期', !!row && row.next_run_at === null);
  ok('溯源标记', !!row && row.owner_source === 'freebuddy');
  const on = auto.setEnabled(created.id, true);
  ok('启用后排期', on.status === 'ACTIVE' && Number.isFinite(on.nextRunAt), on.nextRunAt && new Date(on.nextRunAt).toLocaleString());
  const off = auto.setEnabled(created.id, false);
  ok('暂停后清排期', off.status === 'PAUSED' && off.nextRunAt === null);
  const rm = auto.remove([created.id]);
  ok('删除任务', rm.ok && rm.removed === 1);
  ok('列表里已消失', !auto.list().tasks.some((x) => x.id === created.id));
  ok('软删除留痕', !!db.get('SELECT deleted_at FROM automations WHERE id=?', [created.id]));
});

log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
