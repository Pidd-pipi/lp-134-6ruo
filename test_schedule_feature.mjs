// 每周排班 / 休诊 / 预约 端到端接口测试（Node 内置 fetch）
const BASE = 'http://localhost:3234/api';

let pass = 0;
let fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`✅ PASS - ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`❌ FAIL - ${name}${extra ? '  ' + extra : ''}`);
  }
};

const jd = (offsetDays = 0) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const login = async (username, password) => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await r.json();
  return { status: r.status, token: data.token, user: data.user };
};

const api = async (method, path, token, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
};

const main = async () => {
  // 1. 登录咨询师（种子账号）
  const c = await login('testcounselor', 'counselor123');
  ok('咨询师登录', c.status === 200 && !!c.token);
  const cToken = c.token;
  const cUser = c.user;

  // 拿到咨询师 profile id
  const approved = await api('GET', '/counselors/approved', cToken);
  const profile = approved.data.find(x => x.user.id === cUser.id);
  ok('找到咨询师档案', !!profile, profile?.id);
  const counselorId = profile.id;

  // 2. 保存每周排班：周一 09:00-10:00、周三 14:00-15:00
  const ts = Math.floor(Date.now() / 1000);
  const r1 = await api('POST', '/counselors/weekly-schedule', cToken, {
    rules: [
      { weekday: 1, startTime: '09:00', endTime: '10:00' },
      { weekday: 3, startTime: '14:00', endTime: '15:00' }
    ]
  });
  ok('保存每周排班成功', r1.status === 200, r1.data.message);
  const expectInHorizon = (weekday, time) => Array.from({ length: 14 }, (_, i) => {
    const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + i);
    const hmNow = new Date().toISOString().slice(11, 16);
    return d.getUTCDay() === weekday && !(i === 0 && time <= hmNow);
  }).filter(Boolean).length;
  const expectedMon = expectInHorizon(1, '09:00');
  const expectedWed = expectInHorizon(3, '14:00');
  const expectedCount = expectedMon + expectedWed;
  ok('新建时段数不超过理论值(去重)', r1.data.createdCount <= expectedCount && r1.data.createdCount >= 0,
    `generated=${r1.data.createdCount} expected<=${expectedCount}`);

  // 3. 再次保存相同规则 + 一条新规则，不重复生成
  const r2 = await api('POST', '/counselors/weekly-schedule', cToken, {
    rules: [
      { weekday: 1, startTime: '09:00', endTime: '10:00' },
      { weekday: 5, startTime: `${16}:00`, endTime: '17:00' }
    ]
  });
  const friCount = expectInHorizon(5, '16:00');
  ok('重复保存接口成功且不重复生成', r2.status === 200 && r2.data.createdCount <= friCount,
    `generated=${r2.data.createdCount} friMax=${friCount}`);

  // 规则列表有 3 条
  const r3 = await api('GET', '/counselors/weekly-schedule', cToken);
  ok('查询到3条每周规则', r3.data.weeklySchedules?.length === 3,
    `count=${r3.data.weeklySchedules?.length}`);

  // 4. 来访者视角：时段可预约列表存在
  const client = await login('testuser', 'user123456');
  let clientToken = client.token;
  if (!clientToken) {
    // 种子用户可能没有，注册一个
    const reg = await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `client_${ts}`, email: `client_${ts}@t.com`, password: 'password123'
      })
    }).then(x => x.json());
    clientToken = reg.token;
  }
  ok('来访者登录', !!clientToken);

  const schedResp = await api('GET', `/counselors/${counselorId}/schedules`, clientToken);
  const schedules = schedResp.data;
  ok('可预约时段非空且都可用',
    schedules.length > 0 && schedules.every(s => s.isAvailable),
    `count=${schedules.length}`);
  const within14 = schedules.every(s => {
    const diff = (new Date(s.date).getTime() - Date.now()) / 86400000;
    return diff >= -1 && diff < 14;
  });
  ok('生成时段都在未来14天内', within14);

  // 周一09:00、周三14:00、周五16:00 规则均已在可约列表中体现（含历史运行已生成的）
  const byWeekdayTime = (w, t) => schedules.filter(s => {
    const d = new Date(s.date);
    return d.getUTCDay() === w && s.startTime === t;
  }).length;
  ok('三条规则的未来时段均已生成',
    byWeekdayTime(1, '09:00') === expectInHorizon(1, '09:00') &&
    byWeekdayTime(3, '14:00') === expectInHorizon(3, '14:00') &&
    byWeekdayTime(5, '16:00') === expectInHorizon(5, '16:00'),
    `mon=${byWeekdayTime(1, '09:00')} wed=${byWeekdayTime(3, '14:00')} fri=${byWeekdayTime(5, '16:00')}`);

  // 5. 预约一个时段（用于休诊冲突验证）—— 找明天或之后的第一个周一/周三/周五时段
  const target = schedules.find(s => {
    const diff = (new Date(s.date).getTime() - Date.now()) / 86400000;
    return diff >= 1;
  });
  ok('找到可预约的未来时段', !!target, target ? target.date.slice(0, 10) : '');
  const bookResp = await api('POST', '/appointments', clientToken, {
    scheduleId: target.id, title: '冲突测试预约'
  });
  ok('来访者预约成功', bookResp.status === 200, bookResp.data?.error || '');

  // 该时段不再出现在可预约列表
  const afterBook = await api('GET', `/counselors/${counselorId}/schedules`, clientToken);
  ok('已预约时段从可约列表消失', !afterBook.data.some(s => s.id === target.id));

  // 6. 对已预约日期设休诊 -> 拒绝并说明冲突
  const conflictDate = target.date.slice(0, 10);
  const conflictResp = await api('POST', '/counselors/day-offs', cToken, { date: conflictDate });
  ok('有预约时拒绝休诊(409)', conflictResp.status === 409, conflictResp.data.error?.slice(0, 60));
  ok('冲突说明包含来访者和时间',
    /来访者/.test(conflictResp.data.error || '') && /\d{2}:\d{2}/.test(conflictResp.data.error || ''));

  // 休诊日列表不包含冲突日期
  const manageAfterFail = await api('GET', '/counselors/weekly-schedule', cToken);
  ok('拒绝后未创建休诊记录', !manageAfterFail.data.dayOffs.some(d => d.date.slice(0, 10) === conflictDate));

  // 7. 对另一个无预约日期设休诊 -> 成功，当天空闲撤下
  const dayOffTarget = schedules
    .filter(s => s.date.slice(0, 10) !== conflictDate && s.isAvailable)
    .map(s => s.date.slice(0, 10))
    .sort()[0];
  ok('找到无预约日期用于休诊', !!dayOffTarget, dayOffTarget);
  const dayOffResp = await api('POST', '/counselors/day-offs', cToken, {
    date: dayOffTarget, reason: '外出培训'
  });
  ok('无预约日设休诊成功', dayOffResp.status === 200, dayOffResp.data.message);

  const afterDayOff = await api('GET', `/counselors/${counselorId}/schedules`, clientToken);
  const offDaySlots = afterDayOff.data.filter(s => s.date.slice(0, 10) === dayOffTarget);
  ok('休诊日空闲时段全部撤下', offDaySlots.length === 0, `剩余=${offDaySlots.length}`);

  // 其他日期时段保留
  const otherDateKept = afterDayOff.data.some(s => s.date.slice(0, 10) !== dayOffTarget);
  ok('其他日期时段照常保留', otherDateKept, `其他时段=${afterDayOff.data.length}`);

  // 休诊日重复添加排班被拒绝
  const addOnOff = await api('POST', '/counselors/schedule', cToken, {
    date: dayOffTarget, startTime: '20:00', endTime: '21:00'
  });
  ok('休诊日不允许添加排班', addOnOff.status === 400, addOnOff.data.error);

  // 8. 重复设同一天休诊 -> 幂等成功
  const dupOff = await api('POST', '/counselors/day-offs', cToken, { date: dayOffTarget });
  ok('重复设休诊幂等处理', dupOff.status === 200, dupOff.data.error || '');

  // 9. 取消休诊 -> 按每周规则补回时段
  const manageData = await api('GET', '/counselors/weekly-schedule', cToken);
  const offRecord = manageData.data.dayOffs.find(d => d.date.slice(0, 10) === dayOffTarget);
  ok('查询到休诊记录', !!offRecord);
  const cancelOff = await api('DELETE', `/counselors/day-offs/${offRecord.id}`, cToken);
  ok('取消休诊成功', cancelOff.status === 200, cancelOff.data.message);
  const afterCancel = await api('GET', `/counselors/${counselorId}/schedules`, clientToken);
  ok('取消休诊后时段补回', afterCancel.data.some(s => s.date.slice(0, 10) === dayOffTarget));

  // 10. 删除一条每周规则
  const friRule = manageData.data.weeklySchedules.find(r => r.weekday === 5);
  const delRule = await api('DELETE', `/counselors/weekly-schedule/${friRule.id}`, cToken);
  ok('删除每周规则成功', delRule.status === 200, delRule.data.message);

  // 11. 参数校验：结束早于开始、星期越界、坏日期
  const bad1 = await api('POST', '/counselors/weekly-schedule', cToken, {
    rules: [{ weekday: 1, startTime: '11:00', endTime: '10:00' }]
  });
  ok('结束早于开始被拒', bad1.status === 400);
  const bad2 = await api('POST', '/counselors/weekly-schedule', cToken, {
    rules: [{ weekday: 9, startTime: '10:00', endTime: '11:00' }]
  });
  ok('星期越界被拒', bad2.status === 400);
  const bad3 = await api('POST', '/counselors/day-offs', cToken, { date: '2020-01-01' });
  ok('过去日期休诊被拒', bad3.status === 400, bad3.data.error);

  // 12. 非咨询师不能访问管理接口
  const forbidden = await api('GET', '/counselors/weekly-schedule', clientToken);
  ok('来访者无法访问排班管理', forbidden.status === 403);

  console.log(`\n${'='.repeat(50)}\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
