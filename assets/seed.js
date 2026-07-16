// seed.js —— 原型首次使用的示例数据（演示四类能力）
(function () {
  'use strict';

  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  }

  window.SeedData = {
    build() {
      const work = { id: 'cat_work', name: '工作', color: '#0ea5e9', order: 0 };
      const life = { id: 'cat_life', name: '生活', color: '#ec4899', order: 1 };
      const proj = { id: 'cat_proj', name: '项目A', color: '#8b5cf6', order: 2 };

      const entries = [
        {
          id: 'e1', categoryId: 'cat_work', type: 'task',
          title: '提交季度复盘文档', content: '周五前发给 leader，附上数据截图',
          done: false, createdAt: daysAgo(0), updatedAt: daysAgo(0),
        },
        {
          id: 'e2', categoryId: 'cat_work', type: 'task',
          title: '预约下周三的 1:1', content: '', done: true,
          createdAt: daysAgo(2), updatedAt: daysAgo(1),
        },
        {
          id: 'e3', categoryId: 'cat_work', type: 'meeting',
          title: '周会 2026-07-16', content:
            '1. 新版本下周提测\n2. 小李负责登录模块重构\n3. 风险：第三方接口不稳定，需加降级',
          createdAt: daysAgo(0), updatedAt: daysAgo(0),
        },
        {
          id: 'e4', categoryId: 'cat_work', type: 'ledger',
          title: '打车去客户现场', content: '', amount: 68.5, direction: 'expense',
          note: '滴滴', createdAt: daysAgo(1), updatedAt: daysAgo(1),
        },
        {
          id: 'e5', categoryId: 'cat_life', type: 'ledger',
          title: '本月工资', content: '', amount: 18500, direction: 'income',
          note: '公司账户', createdAt: daysAgo(5), updatedAt: daysAgo(5),
        },
        {
          id: 'e6', categoryId: 'cat_life', type: 'note',
          title: '想看的电影', content: '《奥本海默》《坠落的审判》——周末有空看看',
          createdAt: daysAgo(3), updatedAt: daysAgo(3),
        },
        {
          id: 'e7', categoryId: 'cat_life', type: 'task',
          title: '给爸妈打电话', content: '问问体检结果', done: false,
          createdAt: daysAgo(1), updatedAt: daysAgo(1),
        },
        {
          id: 'e8', categoryId: 'cat_proj', type: 'ledger',
          title: '云资源月账单', content: '', amount: 312.0, direction: 'expense',
          note: '腾讯云 SCF+COS', createdAt: daysAgo(4), updatedAt: daysAgo(4),
        },
        {
          id: 'e9', categoryId: 'cat_proj', type: 'note',
          title: '账号体系方案草稿', content:
            '主密码 + PBKDF2 派生密钥，浏览器端 AES-GCM 加密，COS 只存密文。',
          createdAt: daysAgo(2), updatedAt: daysAgo(2),
        },
      ];

      return {
        version: 1,
        categories: [work, life, proj],
        entries: entries,
      };
    },
  };
})();
