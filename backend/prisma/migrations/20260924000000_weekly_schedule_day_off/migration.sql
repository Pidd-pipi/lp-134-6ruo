-- 清理存量的重复排班（同咨询师、同日期、同起止时间），保留优先级最高的一条：
-- 1. 已被预约引用的排班优先保留；2. 创建时间更早的优先；3. id 更小的兜底
DELETE FROM "schedules" s1
WHERE NOT EXISTS (
  SELECT 1 FROM "appointments" a WHERE a."scheduleId" = s1.id
)
AND EXISTS (
  SELECT 1 FROM "schedules" s2
  WHERE s2."counselorId" = s1."counselorId"
    AND s2."date" = s1."date"
    AND s2."startTime" = s1."startTime"
    AND s2."endTime" = s1."endTime"
    AND s2.id <> s1.id
    AND (
      EXISTS (SELECT 1 FROM "appointments" a WHERE a."scheduleId" = s2.id)
      OR s2."createdAt" < s1."createdAt"
      OR (s2."createdAt" = s1."createdAt" AND s2.id < s1.id)
    )
);

-- CreateTable: 每周固定排班规则
CREATE TABLE "weekly_schedules" (
  "id" TEXT NOT NULL,
  "counselorId" TEXT NOT NULL,
  "weekday" INTEGER NOT NULL,
  "startTime" TEXT NOT NULL,
  "endTime" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "weekly_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable: 休诊日
CREATE TABLE "day_offs" (
  "id" TEXT NOT NULL,
  "counselorId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "day_offs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schedules_counselorId_date_startTime_endTime_key" ON "schedules"("counselorId", "date", "startTime", "endTime");

CREATE INDEX "schedules_counselorId_date_idx" ON "schedules"("counselorId", "date");

CREATE UNIQUE INDEX "weekly_schedules_counselorId_weekday_startTime_endTime_key" ON "weekly_schedules"("counselorId", "weekday", "startTime", "endTime");

CREATE UNIQUE INDEX "day_offs_counselorId_date_key" ON "day_offs"("counselorId", "date");

-- AddForeignKey
ALTER TABLE "weekly_schedules" ADD CONSTRAINT "weekly_schedules_counselorId_fkey" FOREIGN KEY ("counselorId") REFERENCES "counselor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "day_offs" ADD CONSTRAINT "day_offs_counselorId_fkey" FOREIGN KEY ("counselorId") REFERENCES "counselor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
