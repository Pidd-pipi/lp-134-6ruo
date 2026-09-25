import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { counselorAPI, appointmentAPI } from '../services/api';
import { Schedule, MySchedule } from '../types';
import { useAuth } from '../context/AuthContext';

const weekDays = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' }
];

const CounselorDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [counselor, setCounselor] = useState<any>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [mySchedules, setMySchedules] = useState<MySchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSchedule, setSelectedSchedule] = useState<string | null>(null);
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [bookingData, setBookingData] = useState({
    title: '',
    description: ''
  });
  const [weeklyForm, setWeeklyForm] = useState({ dayOfWeek: 1, startTime: '', endTime: '' });
  const [dayOffDate, setDayOffDate] = useState('');
  const { user } = useAuth();

  const isOwner = !!user && user.role === 'COUNSELOR' && counselor?.user?.id === user.id;

  const refreshSchedules = async () => {
    const schedulesRes = await counselorAPI.getSchedules(id!);
    setSchedules(schedulesRes.data);
  };

  const refreshMySchedules = async () => {
    const res = await counselorAPI.getMySchedules();
    setMySchedules(res.data);
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [counselorRes, schedulesRes] = await Promise.all([
          counselorAPI.getCounselor(id!),
          counselorAPI.getSchedules(id!)
        ]);
        setCounselor(counselorRes.data);
        setSchedules(schedulesRes.data);
        if (user?.role === 'COUNSELOR' && counselorRes.data?.user?.id === user.id) {
          const myRes = await counselorAPI.getMySchedules();
          setMySchedules(myRes.data);
        }
      } catch (error) {
        console.error('获取咨询师详情失败:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [id, user]);

  const handleWeeklySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!weeklyForm.startTime || !weeklyForm.endTime) {
      alert('请选择开始时间和结束时间');
      return;
    }
    if (weeklyForm.startTime >= weeklyForm.endTime) {
      alert('开始时间必须早于结束时间');
      return;
    }

    try {
      const res = await counselorAPI.createWeeklySchedule(weeklyForm);
      alert(res.data.message);
      await Promise.all([refreshSchedules(), refreshMySchedules()]);
    } catch (error: any) {
      alert(error.response?.data?.error || '保存每周排班失败');
    }
  };

  const handleDayOff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dayOffDate) {
      alert('请选择休诊日期');
      return;
    }
    if (!confirm(`确定将 ${dayOffDate} 设为休诊吗？当天的空闲时段将被撤下。`)) return;

    try {
      const res = await counselorAPI.setDayOff({ date: dayOffDate });
      alert(res.data.message);
      setDayOffDate('');
      await Promise.all([refreshSchedules(), refreshMySchedules()]);
    } catch (error: any) {
      const data = error.response?.data;
      if (data?.conflicts?.length) {
        const detail = data.conflicts
          .map((c: any) => `${c.startTime} - ${c.endTime}《${c.title}》`)
          .join('\n');
        alert(`${data.error}\n冲突预约：\n${detail}`);
      } else {
        alert(data?.error || '设置休诊失败');
      }
    }
  };

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

  const groupedSchedules = schedules.reduce((acc, schedule) => {
    const date = new Date(schedule.date).toLocaleDateString('zh-CN');
    if (!acc[date]) acc[date] = [];
    acc[date].push(schedule);
    return acc;
  }, {} as Record<string, Schedule[]>);

  const groupedMySchedules = mySchedules.reduce((acc, schedule) => {
    const date = new Date(schedule.date).toLocaleDateString('zh-CN');
    if (!acc[date]) acc[date] = [];
    acc[date].push(schedule);
    return acc;
  }, {} as Record<string, MySchedule[]>);

  const myScheduleStatus = (s: MySchedule) => {
    if (s.appointment && (s.appointment.status === 'PENDING' || s.appointment.status === 'CONFIRMED')) {
      return { label: '已预约', className: 'bg-green-100 text-green-700' };
    }
    if (s.isAvailable) {
      return { label: '可预约', className: 'bg-blue-100 text-blue-700' };
    }
    return { label: '已撤下', className: 'bg-gray-100 text-gray-500' };
  };

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
          <h2 className="text-xl font-bold text-gray-800 mb-6">排班管理</h2>

          <div className="grid md:grid-cols-2 gap-6 mb-8">
            <form onSubmit={handleWeeklySubmit} className="border rounded-lg p-4">
              <h3 className="font-semibold text-gray-700 mb-1">设置每周排班</h3>
              <p className="text-sm text-gray-500 mb-4">保存后自动生成未来14天对应的空闲时段</p>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">星期</label>
                  <select
                    value={weeklyForm.dayOfWeek}
                    onChange={e => setWeeklyForm({ ...weeklyForm, dayOfWeek: Number(e.target.value) })}
                    className="input-field"
                  >
                    {weekDays.map(d => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">开始时间</label>
                    <input
                      type="time"
                      value={weeklyForm.startTime}
                      onChange={e => setWeeklyForm({ ...weeklyForm, startTime: e.target.value })}
                      className="input-field"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">结束时间</label>
                    <input
                      type="time"
                      value={weeklyForm.endTime}
                      onChange={e => setWeeklyForm({ ...weeklyForm, endTime: e.target.value })}
                      className="input-field"
                      required
                    />
                  </div>
                </div>
                <button type="submit" className="btn-primary w-full">
                  保存每周排班
                </button>
              </div>
            </form>

            <form onSubmit={handleDayOff} className="border rounded-lg p-4">
              <h3 className="font-semibold text-gray-700 mb-1">设置休诊日</h3>
              <p className="text-sm text-gray-500 mb-4">当天空闲时段将被撤下；如已有预约则无法休诊</p>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">休诊日期</label>
                  <input
                    type="date"
                    value={dayOffDate}
                    onChange={e => setDayOffDate(e.target.value)}
                    className="input-field"
                    required
                  />
                </div>
                <button type="submit" className="w-full px-4 py-2 rounded-lg bg-red-50 text-red-600 border border-red-300 hover:bg-red-100 transition-colors">
                  设为休诊
                </button>
              </div>
            </form>
          </div>

          <h3 className="font-semibold text-gray-700 mb-3">未来14天排班</h3>
          {Object.keys(groupedMySchedules).length === 0 ? (
            <div className="text-center py-6 text-gray-500">暂无排班，请先设置每周排班</div>
          ) : (
            <div className="space-y-4">
              {Object.entries(groupedMySchedules).map(([date, daySchedules]) => (
                <div key={date}>
                  <h4 className="text-sm font-semibold text-gray-600 mb-2">{date}</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    {daySchedules.map(schedule => {
                      const status = myScheduleStatus(schedule);
                      return (
                        <div key={schedule.id} className="p-3 rounded-lg border-2 border-gray-200">
                          <p className="font-medium">{schedule.startTime} - {schedule.endTime}</p>
                          <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs ${status.className}`}>
                            {status.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
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
