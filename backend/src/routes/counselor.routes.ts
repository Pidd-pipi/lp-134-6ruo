import { Router } from 'express';
import { z } from 'zod';
import prisma from '../config/prisma.js';
import { authMiddleware, AuthRequest, requireRole } from '../middleware/auth.middleware.js';
import { sendInternalError, sendValidationError } from '../utils/httpResponses.js';

const router = Router();

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
  startTime: z.string().min(1),
  endTime: z.string().min(1)
});

const weeklyScheduleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:mm'),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:mm')
});

const dayOffSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
});

const reviewCounselorSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  rejectionReason: z.string().optional()
});

const startOfDay = (d: Date): Date => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const dayKey = (d: Date): string => {
  const local = new Date(d);
  return `${local.getFullYear()}-${local.getMonth()}-${local.getDate()}`;
};

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
              gte: startOfDay(new Date())
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

    const schedule = await prisma.schedule.create({
      data: {
        counselorId: counselor.id,
        date: new Date(validated.date),
        startTime: validated.startTime,
        endTime: validated.endTime,
        isAvailable: true
      }
    });

    res.json({
      message: '排班创建成功',
      schedule
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '创建排班错误', '创建排班失败');
  }
});

router.post('/schedule/weekly', authMiddleware, requireRole(['COUNSELOR']), async (req: AuthRequest, res) => {
  try {
    const validated = weeklyScheduleSchema.parse(req.body);
    const userId = req.user!.id;

    if (validated.startTime >= validated.endTime) {
      return res.status(400).json({ error: '开始时间必须早于结束时间' });
    }

    const counselor = await prisma.counselorProfile.findUnique({
      where: { userId }
    });

    if (!counselor || counselor.status !== 'APPROVED') {
      return res.status(403).json({ error: '您不是认证咨询师' });
    }

    const today = startOfDay(new Date());
    const windowEnd = new Date(today);
    windowEnd.setDate(windowEnd.getDate() + 14);

    const targetDates: Date[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      if (d.getDay() === validated.dayOfWeek) {
        targetDates.push(d);
      }
    }

    const existing = await prisma.schedule.findMany({
      where: {
        counselorId: counselor.id,
        date: { gte: today, lt: windowEnd }
      },
      select: { date: true, startTime: true, endTime: true }
    });

    const existingKeys = new Set(
      existing.map(s => `${dayKey(s.date)}|${s.startTime}|${s.endTime}`)
    );

    const toCreate = targetDates.filter(
      d => !existingKeys.has(`${dayKey(d)}|${validated.startTime}|${validated.endTime}`)
    );

    if (toCreate.length > 0) {
      await prisma.schedule.createMany({
        data: toCreate.map(d => ({
          counselorId: counselor.id,
          date: d,
          startTime: validated.startTime,
          endTime: validated.endTime,
          isAvailable: true
        }))
      });
    }

    res.json({
      message: `每周排班已保存：新增 ${toCreate.length} 个空闲时段，${targetDates.length - toCreate.length} 个已存在跳过`,
      created: toCreate.length,
      skipped: targetDates.length - toCreate.length
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '保存每周排班错误', '保存每周排班失败');
  }
});

router.post('/schedule/day-off', authMiddleware, requireRole(['COUNSELOR']), async (req: AuthRequest, res) => {
  try {
    const validated = dayOffSchema.parse(req.body);
    const userId = req.user!.id;

    const counselor = await prisma.counselorProfile.findUnique({
      where: { userId }
    });

    if (!counselor || counselor.status !== 'APPROVED') {
      return res.status(403).json({ error: '您不是认证咨询师' });
    }

    const [year, month, day] = validated.date.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const schedules = await prisma.schedule.findMany({
      where: {
        counselorId: counselor.id,
        date: { gte: dayStart, lt: dayEnd }
      },
      include: {
        appointment: {
          select: { id: true, status: true, title: true }
        }
      }
    });

    const conflicts = schedules.filter(
      s => s.appointment && ['PENDING', 'CONFIRMED'].includes(s.appointment.status)
    );

    if (conflicts.length > 0) {
      return res.status(400).json({
        error: `该日期已有 ${conflicts.length} 个进行中的预约，无法设为休诊`,
        conflicts: conflicts.map(s => ({
          date: validated.date,
          startTime: s.startTime,
          endTime: s.endTime,
          title: s.appointment!.title,
          status: s.appointment!.status
        }))
      });
    }

    const removableIds = schedules.filter(s => !s.appointment).map(s => s.id);
    const closableIds = schedules.filter(s => s.appointment && s.isAvailable).map(s => s.id);

    await prisma.$transaction([
      prisma.schedule.deleteMany({ where: { id: { in: removableIds } } }),
      prisma.schedule.updateMany({ where: { id: { in: closableIds } }, data: { isAvailable: false } })
    ]);

    res.json({
      message: `已设为休诊，撤下 ${removableIds.length + closableIds.length} 个空闲时段，其他日期不受影响`,
      removed: removableIds.length + closableIds.length
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '设置休诊错误', '设置休诊失败');
  }
});

router.get('/my/schedules', authMiddleware, requireRole(['COUNSELOR']), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    const counselor = await prisma.counselorProfile.findUnique({
      where: { userId }
    });

    if (!counselor) {
      return res.status(403).json({ error: '您不是认证咨询师' });
    }

    const schedules = await prisma.schedule.findMany({
      where: {
        counselorId: counselor.id,
        date: { gte: startOfDay(new Date()) }
      },
      include: {
        appointment: {
          select: { id: true, status: true, title: true }
        }
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }]
    });

    res.json(schedules);
  } catch (error) {
    sendInternalError(res, error, '获取我的排班错误', '获取我的排班失败');
  }
});

router.get('/:id/schedules', async (req, res) => {
  try {
    const { id } = req.params;

    const schedules = await prisma.schedule.findMany({
      where: {
        counselorId: id,
        date: {
          gte: startOfDay(new Date())
        },
        isAvailable: true
      },
      orderBy: { date: 'asc' }
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
