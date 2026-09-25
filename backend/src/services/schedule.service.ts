import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';

export const SCHEDULE_HORIZON_DAYS = 14;

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DAY_MS = 24 * 60 * 60 * 1000;

type WeeklyRule = {
  weekday: number;
  startTime: string;
  endTime: string;
};

type TxClient = Prisma.TransactionClient | typeof prisma;

/** 以 UTC 日历日构造零点时间（排班 date 统一存 UTC 零点，与既有逻辑一致） */
export const parseCalendarDate = (value: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error('日期格式应为 YYYY-MM-DD');
  }
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error('无效的日期');
  }
  return date;
};

export const formatCalendarDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const startOfTodayUtc = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const currentUtcHm = (now: Date): string => {
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
};

/** 时段是否已经过去（日期早于今天，或今天已过开始时间） */
export const isSlotInPast = (date: Date, startTime: string, now: Date = new Date()): boolean => {
  if (date < startOfTodayUtc(now)) return true;
  if (formatCalendarDate(date) === formatCalendarDate(startOfTodayUtc(now))) {
    return startTime <= currentUtcHm(now);
  }
  return false;
};

/**
 * 根据每周排班规则生成从今天起未来 14 天的空闲时段。
 * - 已过的时段（今天早于当前时间）跳过
 * - 休诊日跳过
 * - 同咨询师、同日期、同起止时间已有时段跳过（不重复生成）
 */
export const generateSlotsForRules = async (
  client: TxClient,
  counselorId: string,
  rules: WeeklyRule[],
  now: Date = new Date()
): Promise<{ date: Date; startTime: string; endTime: string }[]> => {
  if (rules.length === 0) return [];

  const today = startOfTodayUtc(now);
  const horizonEnd = new Date(today.getTime() + SCHEDULE_HORIZON_DAYS * DAY_MS);
  const hmNow = currentUtcHm(now);

  const [existingSchedules, dayOffs] = await Promise.all([
    client.schedule.findMany({
      where: {
        counselorId,
        date: { gte: today, lt: horizonEnd }
      },
      select: { date: true, startTime: true, endTime: true }
    }),
    client.dayOff.findMany({
      where: {
        counselorId,
        date: { gte: today, lt: horizonEnd }
      },
      select: { date: true }
    })
  ]);

  const existingKeys = new Set(
    existingSchedules.map(s => `${formatCalendarDate(s.date)} ${s.startTime}-${s.endTime}`)
  );
  const dayOffKeys = new Set(dayOffs.map(d => formatCalendarDate(d.date)));

  const toCreate: { date: Date; startTime: string; endTime: string }[] = [];

  for (const rule of rules) {
    for (let offset = 0; offset < SCHEDULE_HORIZON_DAYS; offset++) {
      const date = new Date(today.getTime() + offset * DAY_MS);
      if (date.getUTCDay() !== rule.weekday) continue;

      const dateKey = formatCalendarDate(date);
      if (dayOffKeys.has(dateKey)) continue;
      if (offset === 0 && rule.startTime <= hmNow) continue;
      if (existingKeys.has(`${dateKey} ${rule.startTime}-${rule.endTime}`)) continue;

      existingKeys.add(`${dateKey} ${rule.startTime}-${rule.endTime}`);
      toCreate.push({ date, startTime: rule.startTime, endTime: rule.endTime });
    }
  }

  if (toCreate.length > 0) {
    await client.schedule.createMany({
      data: toCreate.map(slot => ({
        counselorId,
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        isAvailable: true
      })),
      skipDuplicates: true
    });
  }

  return toCreate;
};

/** 取消休诊后，按每周规则在指定日期补回空闲时段（跳过重复与已过时间） */
export const regenerateSlotsForDates = async (
  client: TxClient,
  counselorId: string,
  dates: Date[],
  now: Date = new Date()
): Promise<number> => {
  const targetDates = [...new Set(dates.map(d => formatCalendarDate(d)))].map(parseCalendarDate);
  if (targetDates.length === 0) return 0;

  const rules = await client.weeklySchedule.findMany({
    where: { counselorId },
    select: { weekday: true, startTime: true, endTime: true }
  });

  const matchingRules = rules.filter(rule =>
    targetDates.some(date => date.getUTCDay() === rule.weekday)
  );

  const slots = await generateSlotsForRules(client, counselorId, matchingRules, now);
  return slots.filter(slot =>
    targetDates.some(d => formatCalendarDate(d) === formatCalendarDate(slot.date))
  ).length;
};
