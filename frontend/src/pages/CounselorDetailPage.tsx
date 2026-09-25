import React, { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { counselorAPI, appointmentAPI } from '../services/api';
import { Schedule, WeeklySchedule, DayOff } from '../types';
import { useAuth } from '../context/AuthContext';

const WEEKDAY_OPTIONS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' }
];

const weekdayLabel = (weekday: number) =>
  WEEKDAY_OPTIONS.find(o => o.value === weekday)?.label ?? '未知';

const formatDateLabel = (dateStr: string) => {
  const d = new Date(dateStr);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

const CounselorDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [counselor, setCounselor] = useState<any>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSchedule, setSelectedSchedule] = useState<string | null>(null);
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [bookingData, setBookingData] = useState({
    title: '',
    description: ''
  });
  const { user } = useAuth();

  const [weeklySchedules, setWeeklySchedules] = useState<WeeklySchedule[]>([]);
  const [dayOffs, setDayOffs] = useState<DayOff[]>([]);
  const [ruleForm, setRuleForm] = useState({ weekday: 1, startTime: '09:00', endTime: '10:00' });
  const [dayOffForm, setDayOffForm] = useState({ date: '', reason: '' });
  const [savingRule, setSavingRule] = useState(false);
  const [savingDayOff, setSavingDayOff] = useState(false);

  const refreshSchedules = useCallback(async () => {
    const schedulesRes = await counselorAPI.getSchedules(id!);
    setSchedules(schedulesRes.data);
  }, [id]);

  const refreshManageData = useCallback(async () => {
    const res = await counselorAPI.getWeeklySchedule();
    setWeeklySchedules(res.data.weeklySchedules);
    setDayOffs(res.data.dayOffs);
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const counselorRes = await counselorAPI.getCounselor(id!);
        setCounselor(counselorRes.data);
        await refreshSchedules();
      } catch (error) {
        console.error('获取咨询师详情失败:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [id, refreshSchedules]);

  const isOwner = !!user && user.role === 'COUNSELOR' && counselor?.user?.id === user.id;

  useEffect(() => {
    if (isOwner) {
      refreshManageData().catch(error => console.error('获取排班管理数据失败:', error));
    }
  }, [isOwner, refreshManageData]);

  const handleBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSchedule) return;

    try {
      await appointmentAPI.create({
        scheduleId: selectedSchedule,
        ...bookingData
      });
      alert('预约成功！请等待咨询师确认。');
      setShowBookingModal(false);
      setBookingData({ title: '', description: '' });
      setSelectedSchedule(null);
      await refreshSchedules();
    } catch (error: any) {
      alert(error.response?.data?.error || '预约失败');
    }
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (ruleForm.endTime <= ruleForm.startTime) {
      alert('结束时间必须晚于开始时间');
      return;
    }
    setSavingRule(true);
    try {
      const res = await counselorAPI.saveWeeklySchedule({
        rules: [{ weekday: ruleForm.weekday, startTime: ruleForm.startTime, endTime: ruleForm.endTime }]
      });
      alert(res.data.message || '每周排班已保存');
      await Promise.all([refreshManageData(), refreshSchedules()]);
    } catch (error: any) {
      alert(error.response?.data?.error || '保存每周排班失败');
    } finally {
      setSavingRule(false);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('确定删除这条每周排班规则吗？已生成的未来时段不会被删除。')) return;
    try {
      await counselorAPI.deleteWeeklySchedule(ruleId);
      await refreshManageData();
    } catch (error: any) {
      alert(error.response?.data?.error || '删除失败');
    }
  };

  const handleCreateDayOff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dayOffForm.date) {
      alert('请选择休诊日期');
      return;
    }
    setSavingDayOff(true);
    try {
      const res = await counselorAPI.createDayOff({
        date: dayOffForm.date,
        reason: dayOffForm.reason || undefined
      });
      alert(res.data.message || '已设为休诊');
      setDayOffForm({ date: '', reason: '' });
      await Promise.all([refreshManageData(), refreshSchedules()]);
    } catch (error: any) {
      alert(error.response?.data?.error || '设置休诊失败');
    } finally {
      setSavingDayOff(false);
    }
  };

  const handleCancelDayOff = async (dayOffId: string) => {
    if (!confirm('取消休诊后，将按每周排班恢复当天的空闲时段。确定继续吗？')) return;
    try {
      const res = await counselorAPI.deleteDayOff(dayOffId);
      alert(res.data.message || '已取消休诊');
      await Promise.all([refreshManageData(), refreshSchedules()]);
    } catch (error: any) {
      alert(error.response?.data?.error || '取消休诊失败');
    }
  };

  const groupedSchedules = schedules.reduce((acc, schedule) => {
    const date = new Date(schedule.date).toLocaleDateString('zh-CN');
    if (!acc[date]) acc[date] = [];
    acc[date].push(schedule);
    return acc;
  }, {} as Record<string, Schedule[]>);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 text-center">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  if (!counselor) {
    return (
      <div className="container mx-auto px-4 py-8 text-center">
        <div className="text-gray-500">咨询师不存在</div>
        <Link to="/counselors" className="text-primary-600 hover:underline mt-4 inline-block">
          返回咨询师列表
        </Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <Link to="/counselors" className="text-primary-600 hover:underline mb-6 inline-block">
        ← 返回咨询师列表
      </Link>

      <div className="bg-white rounded-lg shadow-md p-6 mb-8">
        <div className="flex flex-col md:flex-row gap-8">
          <div className="w-32 h-32 bg-primary-100 rounded-full flex items-center justify-center text-6xl mx-auto md:mx-0">
            👨‍⚕️
          </div>
          <div className="flex-1 text-center md:text-left">
            <h1 className="text-2xl font-bold text-gray-800 mb-2">
              {counselor.user.nickname || counselor.user.username}
            </h1>
            <div className="flex flex-wrap gap-2 justify-center md:justify-start mb-4">
              {counselor.expertise?.map((tag: string, i: number) => (
                <span key={i} className="px-3 py-1 bg-blue-100 text-blue-700 text-sm rounded-full">
                  {tag}
                </span>
              ))}
            </div>
            <p className="text-gray-600 mb-4">{counselor.introduction}</p>
            <div className="text-2xl font-bold text-primary-600">
              ¥{counselor.hourlyRate}/小时
            </div>
          </div>
        </div>
      </div>

      {isOwner && (
        <div className="bg-white rounded-lg shadow-md p-6 mb-8">
          <h2 className="text-xl font-bold text-gray-800 mb-2">排班管理</h2>
          <p className="text-sm text-gray-500 mb-6">
            设置每周固定排班后，系统会自动生成未来 14 天对应的空闲时段；相同日期和时间不会重复生成。
          </p>

          <div className="grid md:grid-cols-2 gap-8">
            <div>
              <h3 className="text-lg font-semibold text-gray-700 mb-4">每周固定排班</h3>
              <form onSubmit={handleSaveRule} className="flex flex-wrap items-end gap-3 mb-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">星期</label>
                  <select
                    value={ruleForm.weekday}
                    onChange={e => setRuleForm({ ...ruleForm, weekday: Number(e.target.value) })}
                    className="input-field"
                  >
                    {WEEKDAY_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">开始时间</label>
                  <input
                    type="time"
                    value={ruleForm.startTime}
                    onChange={e => setRuleForm({ ...ruleForm, startTime: e.target.value })}
                    className="input-field"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">结束时间</label>
                  <input
                    type="time"
                    value={ruleForm.endTime}
                    onChange={e => setRuleForm({ ...ruleForm, endTime: e.target.value })}
                    className="input-field"
                    required
                  />
                </div>
                <button type="submit" className="btn-primary" disabled={savingRule}>
                  {savingRule ? '保存中...' : '保存并生成时段'}
                </button>
              </form>

              {weeklySchedules.length === 0 ? (
                <p className="text-sm text-gray-400 py-3">暂未设置每周排班</p>
              ) : (
                <ul className="space-y-2">
                  {weeklySchedules.map(rule => (
                    <li key={rule.id} className="flex items-center justify-between border rounded-lg px-4 py-2">
                      <span className="text-gray-700">
                        每{weekdayLabel(rule.weekday)} {rule.startTime} - {rule.endTime}
                      </span>
                      <button
                        onClick={() => handleDeleteRule(rule.id)}
                        className="text-red-600 hover:text-red-700 text-sm"
                      >
                        删除规则
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="text-lg font-semibold text-gray-700 mb-4">休诊日</h3>
              <form onSubmit={handleCreateDayOff} className="flex flex-wrap items-end gap-3 mb-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">日期</label>
                  <input
                    type="date"
                    value={dayOffForm.date}
                    onChange={e => setDayOffForm({ ...dayOffForm, date: e.target.value })}
                    className="input-field"
                    required
                  />
                </div>
                <div className="flex-1 min-w-[160px]">
                  <label className="block text-xs text-gray-500 mb-1">备注（可选）</label>
                  <input
                    type="text"
                    value={dayOffForm.reason}
                    onChange={e => setDayOffForm({ ...dayOffForm, reason: e.target.value })}
                    className="input-field"
                    placeholder="如：外出培训"
                  />
                </div>
                <button type="submit" className="btn-secondary" disabled={savingDayOff}>
                  {savingDayOff ? '提交中...' : '设为休诊'}
                </button>
              </form>
              <p className="text-xs text-gray-400 mb-3">
                若当天已有预约，系统会拒绝休诊并提示冲突；休诊后当天的空闲时段将自动撤下。
              </p>

              {dayOffs.length === 0 ? (
                <p className="text-sm text-gray-400 py-3">近期暂无休诊安排</p>
              ) : (
                <ul className="space-y-2">
                  {dayOffs.map(dayOff => (
                    <li key={dayOff.id} className="flex items-center justify-between border rounded-lg px-4 py-2">
                      <span className="text-gray-700">
                        {formatDateLabel(dayOff.date)} 休诊
                        {dayOff.reason && <span className="text-gray-400 text-sm ml-2">（{dayOff.reason}）</span>}
                      </span>
                      <button
                        onClick={() => handleCancelDayOff(dayOff.id)}
                        className="text-primary-600 hover:text-primary-700 text-sm"
                      >
                        取消休诊
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-md p-6">
        <h2 className="text-xl font-bold text-gray-800 mb-6">可预约时间</h2>

        {Object.keys(groupedSchedules).length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            该咨询师暂无可用排班时间
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(groupedSchedules).map(([date, daySchedules]) => (
              <div key={date}>
                <h3 className="text-lg font-semibold text-gray-700 mb-3">{date}</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  {daySchedules.map(schedule => (
                    <button
                      key={schedule.id}
                      onClick={() => {
                        if (!user) {
                          alert('请先登录');
                          return;
                        }
                        if (user.role === 'COUNSELOR') {
                          alert('咨询师无法预约咨询');
                          return;
                        }
                        setSelectedSchedule(schedule.id);
                        setShowBookingModal(true);
                      }}
                      disabled={!schedule.isAvailable}
                      className={`p-3 rounded-lg border-2 transition-colors ${
                        schedule.isAvailable
                          ? 'border-primary-200 hover:border-primary-500 hover:bg-primary-50'
                          : 'border-gray-200 bg-gray-100 cursor-not-allowed text-gray-400'
                      }`}
                    >
                      <p className="font-medium">{schedule.startTime}</p>
                      <p className="text-sm text-gray-500">- {schedule.endTime}</p>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showBookingModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h2 className="text-2xl font-bold mb-6">确认预约</h2>
            <form onSubmit={handleBooking} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  咨询主题 *
                </label>
                <input
                  type="text"
                  value={bookingData.title}
                  onChange={e => setBookingData({ ...bookingData, title: e.target.value })}
                  className="input-field"
                  placeholder="请输入咨询主题"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  详细描述
                </label>
                <textarea
                  value={bookingData.description}
                  onChange={e => setBookingData({ ...bookingData, description: e.target.value })}
                  className="input-field min-h-[100px]"
                  placeholder="简要描述你的问题或困扰..."
                />
              </div>

              <div className="bg-gray-50 p-4 rounded-lg">
                <p className="text-sm text-gray-600">
                  咨询费用：<span className="font-bold text-primary-600">¥{counselor.hourlyRate}</span>
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowBookingModal(false)}
                  className="btn-secondary"
                >
                  取消
                </button>
                <button type="submit" className="btn-primary">
                  确认预约
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default CounselorDetailPage;
