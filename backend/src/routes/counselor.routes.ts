import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';
import { authMiddleware, AuthRequest, requireRole } from '../middleware/auth.middleware.js';
import { sendInternalError, sendValidationError } from '../utils/httpResponses.js';
import {
  WEEKDAY_LABELS,
  formatCalendarDate,
  generateSlotsForRules,
  isSlotInPast,
  parseCalendarDate,
  regenerateSlotsForDates,
  startOfTodayUtc
} from '../services/schedule.service.js';

const router = Router();

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:MM');

const applyCounselorSchema = z.object({
  realName: z.string().min(1),
  certificateNumber: z.string().min(1),
  certificateImage: z.string().min(1),
  expertise: z.array(z.string()).min(1),
  introduction: z.string().optional(),
  hourlyRate: z.number().min(0)
});

const createScheduleSchema = z.object({
  date: z.string().min(1),
  startTime: timeSchema,
  endTime: timeSchema
}).refine(data => data.endTime > data.startTime, {
  message: '结束时间必须晚于开始时间',
  path: ['endTime']
});

const weeklyRuleSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: timeSchema,
  endTime: timeSchema
}).refine(data => data.endTime > data.startTime, {
  message: '结束时间必须晚于开始时间',
  path: ['endTime']
});

const createWeeklyScheduleSchema = z.object({
  rules: z.array(weeklyRuleSchema).min(1)
});

const createDayOffSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD'),
  reason: z.string().max(200).optional()
});

const reviewCounselorSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  rejectionReason: z.string().optional()
});

router.post('/apply', authMiddleware, requireRole(['USER']), async (req: AuthRequest, res) => {
  try {
    const validated = applyCounselorSchema.parse(req.body);
    const userId = req.user!.id;

    const existingProfile = await prisma.counselorProfile.findUnique({
      where: { userId }
    });

    if (existingProfile) {
      return res.status(400).json({ error: '您已提交过咨询师认证申请' });
    }

    const profile = await prisma.counselorProfile.create({
      data: {
        userId,
        realName: validated.realName,
        certificateNumber: validated.certificateNumber,
        certificateImage: validated.certificateImage,
        expertise: validated.expertise,
        introduction: validated.introduction,
        hourlyRate: validated.hourlyRate,
        status: 'PENDING'
      }
    });

    await prisma.user.update({
      where: { id: userId },
      data: { role: 'COUNSELOR' }
    });

    res.json({
      message: '咨询师认证申请已提交，等待审核',
      profile
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '申请咨询师认证错误', '提交申请失败');
  }
});

router.get('/pending', authMiddleware, requireRole(['ADMIN']), async (req: AuthRequest, res) => {
  try {
    const pendingCounselors = await prisma.counselorProfile.findMany({
      where: { status: 'PENDING' },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            nickname: true,
            avatar: true
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    res.json(pendingCounselors);
  } catch (error) {
    sendInternalError(res, error, '获取待审核咨询师错误', '获取待审核咨询师失败');
  }
});

router.post('/:id/review', authMiddleware, requireRole(['ADMIN']), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const validated = reviewCounselorSchema.parse(req.body);

    const profile = await prisma.counselorProfile.findUnique({
      where: { id }
    });

    if (!profile) {
      return res.status(404).json({ error: '咨询师申请不存在' });
    }

    const updatedProfile = await prisma.counselorProfile.update({
      where: { id },
      data: {
        status: validated.status,
        reviewedBy: req.user!.id,
        reviewedAt: new Date(),
        rejectionReason: validated.rejectionReason
      }
    });

    if (validated.status === 'REJECTED') {
      await prisma.user.update({
        where: { id: profile.userId },
        data: { role: 'USER' }
      });
    }

    await prisma.notification.create({
      data: {
        userId: profile.userId,
        type: 'COUNSELOR_REVIEW',
        title: validated.status === 'APPROVED' ? '咨询师认证通过' : '咨询师认证未通过',
        content: validated.status === 'APPROVED' 
          ? '恭喜您，您的咨询师认证已通过审核！'
          : `很抱歉，您的咨询师认证未通过。原因：${validated.rejectionReason || '未填写'}`,
        relatedId: id
      }
    });

    res.json({
      message: '审核完成',
      profile: updatedProfile
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '审核咨询师错误', '审核失败');
  }
});

router.get('/approved', async (req, res) => {
  try {
    const tagId = req.query.tagId as string;

    const where: any = {
      status: 'APPROVED'
    };

    if (tagId) {
      where.tags = {
        some: {
          tagId
        }
      };
    }

    const counselors = await prisma.counselorProfile.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            nickname: true,
            avatar: true
          }
        },
        tags: {
          include: {
            tag: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(counselors);
  } catch (error) {
    sendInternalError(res, error, '获取咨询师列表错误', '获取咨询师列表失败');
  }
});

// 查询当前咨询师的每周排班规则与未来休诊日
router.get('/weekly-schedule', authMiddleware, requireRole(['COUNSELOR']), async (req: AuthRequest, res) => {
  try {
    const counselor = await prisma.counselorProfile.findUnique({
      where: { userId: req.user!.id }
    });

    if (!counselor || counselor.status !== 'APPROVED') {
      return res.status(403).json({ error: '您不是认证咨询师' });
    }

    const [weeklySchedules, dayOffs] = await Promise.all([
      prisma.weeklySchedule.findMany({
        where: { counselorId: counselor.id },
        orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }]
      }),
      prisma.dayOff.findMany({
        where: {
          counselorId: counselor.id,
          date: { gte: startOfTodayUtc() }
        },
        orderBy: { date: 'asc' }
      })
    ]);

    res.json({ weeklySchedules, dayOffs });
  } catch (error) {
    sendInternalError(res, error, '获取每周排班错误', '获取每周排班失败');
  }
});

// 保存每周排班规则，并生成未来 14 天对应的空闲时段（已有时段不重复生成）
router.post('/weekly-schedule', authMiddleware, requireRole(['COUNSELOR']), async (req: AuthRequest, res) => {
  try {
    const validated = createWeeklyScheduleSchema.parse(req.body);
    const userId = req.user!.id;

    const counselor = await prisma.counselorProfile.findUnique({
      where: { userId }
    });

    if (!counselor || counselor.status !== 'APPROVED') {
      return res.status(403).json({ error: '您不是认证咨询师' });
    }

    const ruleKeys = new Set<string>();
    for (const rule of validated.rules) {
      const key = `${rule.weekday}-${rule.startTime}-${rule.endTime}`;
      if (ruleKeys.has(key)) {
        return res.status(400).json({
          error: `${WEEKDAY_LABELS[rule.weekday]} ${rule.startTime}-${rule.endTime} 重复设置`
        });
      }
      ruleKeys.add(key);
    }

    const result = await prisma.$transaction(async (tx) => {
      // 已存在的相同规则保持不变，仅补充新规则
      await tx.weeklySchedule.createMany({
        data: validated.rules.map(rule => ({
          counselorId: counselor.id,
          weekday: rule.weekday,
          startTime: rule.startTime,
          endTime: rule.endTime
        })),
        skipDuplicates: true
      });

      const createdSlots = await generateSlotsForRules(tx, counselor.id, validated.rules);

      const weeklySchedules = await tx.weeklySchedule.findMany({
        where: { counselorId: counselor.id },
        orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }]
      });

      return { weeklySchedules, createdCount: createdSlots.length };
    });

    res.json({
      message: `每周排班已保存，已生成未来14天内 ${result.createdCount} 个空闲时段`,
      weeklySchedules: result.weeklySchedules,
      createdCount: result.createdCount
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '保存每周排班错误', '保存每周排班失败');
  }
});

// 删除一条每周排班规则（已生成的未来时段保留，不影响已有安排）
router.delete('/weekly-schedule/:id', authMiddleware, requireRole(['COUNSELOR']), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const counselor = await prisma.counselorProfile.findUnique({
      where: { userId: req.user!.id }
    });

    if (!counselor) {
      return res.status(403).json({ error: '权限不足' });
    }

    const rule = await prisma.weeklySchedule.findUnique({ where: { id } });

    if (!rule || rule.counselorId !== counselor.id) {
      return res.status(404).json({ error: '每周排班规则不存在' });
    }

    await prisma.weeklySchedule.delete({ where: { id } });

    res.json({ message: '每周排班规则已删除' });
  } catch (error) {
    sendInternalError(res, error, '删除每周排班规则错误', '删除每周排班规则失败');
  }
});

// 设置某一天为休诊：存在有效预约时拒绝并说明冲突；否则撤下当天空闲时段
router.post('/day-offs', authMiddleware, requireRole(['COUNSELOR']), async (req: AuthRequest, res) => {
  try {
    const validated = createDayOffSchema.parse(req.body);
    const userId = req.user!.id;

    let date: Date;
    try {
      date = parseCalendarDate(validated.date);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }

    const startOfToday = startOfTodayUtc();
    if (date < startOfToday) {
      return res.status(400).json({ error: '不能为过去的日期设置休诊' });
    }

    const counselor = await prisma.counselorProfile.findUnique({
      where: { userId }
    });

    if (!counselor || counselor.status !== 'APPROVED') {
      return res.status(403).json({ error: '您不是认证咨询师' });
    }

    const nextDay = new Date(date.getTime() + 24 * 60 * 60 * 1000);

    const conflicts = await prisma.appointment.findMany({
      where: {
        counselorId: userId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        schedule: {
          date: { gte: date, lt: nextDay }
        }
      },
      include: {
        schedule: true,
        client: {
          select: { id: true, username: true, nickname: true }
        }
      }
    });

    if (conflicts.length > 0) {
      const conflictText = conflicts
        .map(a => `${a.schedule.startTime}-${a.schedule.endTime}（来访者：${a.client.nickname || a.client.username}，${a.status === 'CONFIRMED' ? '已确认' : '待确认'}）`)
        .join('、');
      return res.status(409).json({
        error: `${validated.date} 已有 ${conflicts.length} 个预约，无法设置休诊：${conflictText}。请先联系来访者取消或改期后再试。`,
        conflicts: conflicts.map(a => ({
          id: a.id,
          startTime: a.schedule.startTime,
          endTime: a.schedule.endTime,
          status: a.status
        }))
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.dayOff.upsert({
        where: {
          counselorId_date: {
            counselorId: counselor.id,
            date
          }
        },
        update: { reason: validated.reason ?? null },
        create: {
          counselorId: counselor.id,
          date,
          reason: validated.reason
        }
      });

      // 无预约的空闲时段直接撤下；绑定了已取消预约的时段不能硬删，标记为不可用
      await tx.schedule.updateMany({
        where: {
          counselorId: counselor.id,
          date,
          isAvailable: true
        },
        data: { isAvailable: false }
      });

      await tx.schedule.deleteMany({
        where: {
          counselorId: counselor.id,
          date,
          isAvailable: false,
          appointment: null
        }
      });
    });

    res.json({ message: `${validated.date} 已设为休诊，当天空闲时段已撤下` });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '设置休诊错误', '设置休诊失败');
  }
});

// 取消休诊：恢复被撤下的时段，并按每周规则补回当天的空闲时段
router.delete('/day-offs/:id', authMiddleware, requireRole(['COUNSELOR']), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const counselor = await prisma.counselorProfile.findUnique({
      where: { userId: req.user!.id }
    });

    if (!counselor) {
      return res.status(403).json({ error: '权限不足' });
    }

    const dayOff = await prisma.dayOff.findUnique({ where: { id } });

    if (!dayOff || dayOff.counselorId !== counselor.id) {
      return res.status(404).json({ error: '休诊记录不存在' });
    }

    const startOfToday = startOfTodayUtc();

    await prisma.$transaction(async (tx) => {
      await tx.dayOff.delete({ where: { id } });

      if (dayOff.date >= startOfToday) {
        // 恢复仅绑定了已取消预约的时段（确认/待确认/已完成的保持不可约）
        await tx.schedule.updateMany({
          where: {
            counselorId: counselor.id,
            date: dayOff.date,
            isAvailable: false,
            appointment: {
              is: { status: 'CANCELLED' }
            }
          },
          data: { isAvailable: true }
        });

        await regenerateSlotsForDates(tx, counselor.id, [dayOff.date]);
      }
    });

    res.json({ message: `${formatCalendarDate(dayOff.date)} 已取消休诊` });
  } catch (error) {
    sendInternalError(res, error, '取消休诊错误', '取消休诊失败');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const counselor = await prisma.counselorProfile.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            nickname: true,
            avatar: true
          }
        },
        tags: {
          include: {
            tag: true
          }
        },
        schedules: {
          where: {
            date: {
              gte: startOfTodayUtc()
            },
            isAvailable: true
          },
          orderBy: { date: 'asc' }
        }
      }
    });

    if (!counselor || counselor.status !== 'APPROVED') {
      return res.status(404).json({ error: '咨询师不存在或未通过审核' });
    }

    res.json(counselor);
  } catch (error) {
    sendInternalError(res, error, '获取咨询师详情错误', '获取咨询师详情失败');
  }
});

router.post('/schedule', authMiddleware, requireRole(['COUNSELOR']), async (req: AuthRequest, res) => {
  try {
    const validated = createScheduleSchema.parse(req.body);
    const userId = req.user!.id;

    const counselor = await prisma.counselorProfile.findUnique({
      where: { userId }
    });

    if (!counselor || counselor.status !== 'APPROVED') {
      return res.status(403).json({ error: '您不是认证咨询师' });
    }

    let date: Date;
    try {
      date = parseCalendarDate(validated.date);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }

    const dayOff = await prisma.dayOff.findUnique({
      where: {
        counselorId_date: {
          counselorId: counselor.id,
          date
        }
      }
    });

    if (dayOff) {
      return res.status(400).json({ error: `${validated.date} 已设为休诊，无法添加排班` });
    }

    if (isSlotInPast(date, validated.startTime)) {
      return res.status(400).json({ error: '开始时间已过，无法添加过去的排班' });
    }

    try {
      const schedule = await prisma.schedule.create({
        data: {
          counselorId: counselor.id,
          date,
          startTime: validated.startTime,
          endTime: validated.endTime,
          isAvailable: true
        }
      });

      res.json({
        message: '排班创建成功',
        schedule
      });
    } catch (createError) {
      if (
        createError instanceof Prisma.PrismaClientKnownRequestError &&
        createError.code === 'P2002'
      ) {
        return res.status(400).json({ error: '相同日期和时间的排班已存在，请勿重复添加' });
      }
      throw createError;
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '创建排班错误', '创建排班失败');
  }
});

router.get('/:id/schedules', async (req, res) => {
  try {
    const { id } = req.params;

    const schedules = await prisma.schedule.findMany({
      where: {
        counselorId: id,
        date: {
          gte: startOfTodayUtc()
        },
        isAvailable: true
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }]
    });

    res.json(schedules);
  } catch (error) {
    sendInternalError(res, error, '获取咨询师排班错误', '获取排班失败');
  }
});

router.delete('/schedule/:id', authMiddleware, requireRole(['COUNSELOR']), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const counselor = await prisma.counselorProfile.findUnique({
      where: { userId }
    });

    if (!counselor) {
      return res.status(403).json({ error: '权限不足' });
    }

    const schedule = await prisma.schedule.findUnique({
      where: { id },
      include: {
        appointment: true
      }
    });

    if (!schedule || schedule.counselorId !== counselor.id) {
      return res.status(404).json({ error: '排班不存在' });
    }

    if (schedule.appointment) {
      return res.status(400).json({ error: '该排班已有预约，无法删除' });
    }

    await prisma.schedule.delete({
      where: { id }
    });

    res.json({ message: '排班已删除' });
  } catch (error) {
    sendInternalError(res, error, '删除排班错误', '删除排班失败');
  }
});

export default router;
