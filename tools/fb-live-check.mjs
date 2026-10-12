// 真机验收：建一条任务 → 让客户端原生调度器真跑一次 → 收证据 → 清理。
//   node tools/fb-live-check.mjs [minutes]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../src/config.mjs';

const HOST = 'http://127.0.0.1:47842';
const token = fs.readFileSync(path.join(dataDir(), '.api-token'), 'utf8').trim();
const waitMin = Number(process.argv[2] || 4);

async function api(p, body) {
  const res = await fetch(HOST + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-FreeBuddy-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const created = await api('/api/automations/save', {
  task: {
    name: 'FreeBuddy 验收任务',
    prompt: '请只回复两个字：收到。不要调用任何工具，不要创建文件。',
    status: 'ACTIVE',
    scheduleType: 'recurring',
    rrule: 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0',
  },
});
console.log('建任务：', created.ok, created.id, '| 名称:', created.task && created.task.name);
console.log('已排期：', new Date(created.nextRunAt).toLocaleString());

const fired = await api('/api/automations/run', { id: created.id });
console.log('立刻执行（next_run_at 置为当下）：', fired.ok, new Date(fired.nextRunAt).toLocaleString());

const startedAt = Date.now();
let runs = [];
let taskRow = null;
for (let i = 0; i < waitMin * 6; i++) {
  await sleep(10000);
  const list = await api('/api/automations');
  taskRow = (list.tasks || []).find((t) => t.id === created.id) || null;
  runs = list.runs || [];
  const mine = runs.filter((r) => r.automationId === created.id);
  console.log(
    `  +${Math.round((Date.now() - startedAt) / 1000)}s  任务状态=${taskRow && taskRow.status}  运行中=${taskRow && taskRow.running}  本次运行记录=${mine.length}  总记录=${runs.length}`,
  );
  if (mine.some((r) => r.status && r.status !== 'running') || (taskRow && taskRow.lastRunAt)) break;
}

console.log('\n=== 结论 ===');
console.log('任务 lastRunAt：', taskRow && taskRow.lastRunAt ? new Date(taskRow.lastRunAt).toLocaleString() : '（未更新）');
const mine = runs.filter((r) => r.automationId === created.id);
console.log('该任务的运行记录：', JSON.stringify(mine, null, 1).slice(0, 1200));
console.log('调度器常量是否被改：', '见 automation.log');

// 清理
const del = await api('/api/automations/delete', { ids: [created.id] });
console.log('\n清理任务：', JSON.stringify(del));
