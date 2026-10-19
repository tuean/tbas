/**
 * Demo snapshots used by the extension's "载入示例" button and by
 * `tbas demo`. They are intentionally realistic: multiple windows, colored
 * groups, a duplicate URL with tracking parameters, pinned tabs and an
 * un-restorable edge:// page.
 */

import { buildSnapshot } from '../extension/lib/core.js';

function officeSnapshot(now) {
  const created = new Date(now);
  created.setDate(created.getDate() - 2);
  created.setHours(18, 10, 0, 0);

  return buildSnapshot({
    windows: [
      {
        id: 1,
        focused: true,
        tabs: [
          { id: 101, url: 'https://jira.example.com/browse/DEMO-10895', title: 'DEMO-10895 标签页快照工具 · Jira', pinned: true, active: true, index: 0, groupId: 11 },
          { id: 102, url: 'https://jira.example.com/browse/DEMO-10895?utm_source=weekly', title: 'DEMO-10895 标签页快照工具 · Jira', pinned: false, active: false, index: 1, groupId: 11 },
          { id: 103, url: 'https://confluence.example.com/display/DEMO/TBAS+设计评审', title: 'TBAS 设计评审 - DEMO - Confluence', pinned: false, active: false, index: 2, groupId: 11 },
          { id: 104, url: 'https://gitlab.example.com/demo/frontend/-/merge_requests/128', title: 'feat: 标签页快照恢复 !128 · Merge Requests · GitLab', pinned: false, active: false, index: 3, groupId: 11 },
          { id: 105, url: 'https://github.com/facebook/react/pull/29876', title: 'Fix hydration mismatch by… by reactjs · Pull Request #29876', pinned: false, active: false, index: 4, groupId: 12 },
          { id: 106, url: 'https://stackoverflow.com/questions/79234567/chrome-tabgroups-api-restore-groups', title: 'How to restore chrome tab groups after restart? - Stack Overflow', pinned: false, active: false, index: 5, groupId: 12 },
          { id: 107, url: 'https://developer.mozilla.org/zh-CN/docs/Web/API/Compression_Streams_API', title: 'Compression Streams API - MDN Web Docs', pinned: false, active: false, index: 6, groupId: 13 },
          { id: 108, url: 'https://developer.chrome.com/docs/extensions/reference/api/tabGroups', title: 'chrome.tabGroups | API reference | Chrome for Developers', pinned: false, active: false, index: 7, groupId: 13 },
          { id: 109, url: 'https://www.typescriptlang.org/docs/handbook/2/generics.html', title: 'TypeScript: Handbook - Generics', pinned: false, active: false, index: 8, groupId: 13 },
          { id: 110, url: 'https://outlook.office.com/mail/inbox', title: '邮件 - 收件箱 - Outlook', pinned: false, active: false, index: 9, groupId: -1 },
          { id: 111, url: 'edge://settings/profiles', title: '设置 - 个人资料', pinned: false, active: false, index: 10, groupId: -1 },
        ],
      },
      {
        id: 2,
        focused: false,
        tabs: [
          { id: 201, url: 'https://arxiv.org/abs/2402.12345', title: '[2402.12345] Efficient Retrieval-Augmented Generation: A Survey', pinned: false, active: true, index: 0, groupId: 21 },
          { id: 202, url: 'https://www.semanticscholar.org/search?q=hybrid+retrieval', title: 'Hybrid retrieval - Semantic Scholar', pinned: false, active: false, index: 1, groupId: 21 },
          { id: 203, url: 'https://docs.pinecone.io/guides/indexes/choose-a-metric', title: 'Choose a similarity metric - Pinecone Docs', pinned: false, active: false, index: 2, groupId: 21 },
          { id: 204, url: 'https://weaviate.io/blog/hybrid-search-fusion-algorithms', title: 'Hybrid Search Fusion Algorithms | Weaviate', pinned: false, active: false, index: 3, groupId: 21 },
          { id: 205, url: 'https://wiki.example.com/pages/viewpage.action?pageId=1000001', title: '演示周报模板 - Demo Wiki', pinned: false, active: false, index: 4, groupId: 22 },
          { id: 206, url: 'https://grafana.example.com/d/demo-overview', title: '演示总览 - Grafana', pinned: false, active: false, index: 5, groupId: 22 },
          { id: 207, url: 'https://www.feishu.cn/docx/TbasWeeklyNotes', title: '本周进展与下周计划 - 飞书文档', pinned: false, active: false, index: 6, groupId: -1 },
        ],
      },
    ],
    groups: [
      { id: 11, title: '项目 · 客户门户', color: 'blue', collapsed: false },
      { id: 12, title: '代码审查', color: 'purple', collapsed: false },
      { id: 13, title: '文档', color: 'green', collapsed: false },
      { id: 21, title: '调研 · 混合检索', color: 'cyan', collapsed: false },
      { id: 22, title: '周报素材', color: 'yellow', collapsed: true },
    ],
    meta: {
      id: 'demo-office-v1',
      name: '示例 · 办公周五归档',
      env: 'office',
      envLabel: '办公',
      tags: ['示例', '周五'],
      browser: 'Edge',
      extensionVersion: '0.1.0',
      notes: '演示用快照。包含两个窗口、5 个分组、一个重复标签和一个 edge:// 内部页。',
    },
    now: created,
  });
}

function homeSnapshot(now) {
  const created = new Date(now);
  created.setDate(created.getDate() - 1);
  created.setHours(20, 45, 0, 0);

  return buildSnapshot({
    windows: [
      {
        id: 3,
        focused: true,
        tabs: [
          { id: 301, url: 'https://www.xiaohongshu.com/explore/kyoto-autumn-2025', title: '京都红叶季 5 天 4 晚懒人攻略 - 小红书', pinned: false, active: true, index: 0, groupId: 31 },
          { id: 302, url: 'https://www.google.com/maps/place/Kyoto', title: 'Kyoto · Google Maps', pinned: false, active: false, index: 1, groupId: 31 },
          { id: 303, url: 'https://www.booking.com/city/jp/kyoto.zh-cn.html', title: '京都酒店推荐 - Booking.com', pinned: false, active: false, index: 2, groupId: 31 },
          { id: 304, url: 'https://www.jrpass.com/zh/coverage', title: 'JR Pass 适用范围与路线图', pinned: false, active: false, index: 3, groupId: 31 },
          { id: 305, url: 'https://item.jd.com/100012345678.html', title: '索尼 WH-1000XM5 降噪耳机 - 京东', pinned: false, active: false, index: 4, groupId: 32 },
          { id: 306, url: 'https://detail.tmall.com/item.htm?id=654321', title: '行李箱 20 寸登机箱 - 天猫', pinned: false, active: false, index: 5, groupId: 32 },
          { id: 307, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '用扩展管理你的标签页 · Bilibili', pinned: true, active: false, index: 6, groupId: 33 },
          { id: 308, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Kyoto in Autumn - 4K walking tour - YouTube', pinned: false, active: false, index: 7, groupId: 33 },
          { id: 309, url: 'https://www.zhihu.com/question/123456789', title: '一个人去京都需要注意什么？ - 知乎', pinned: false, active: false, index: 8, groupId: -1 },
          { id: 310, url: 'https://www.douban.com/note/888888888/', title: '京都寺院巡礼 - 豆瓣', pinned: false, active: false, index: 9, groupId: -1 },
        ],
      },
    ],
    groups: [
      { id: 31, title: '旅行 · 京都', color: 'orange', collapsed: false },
      { id: 32, title: '购物清单', color: 'red', collapsed: true },
      { id: 33, title: '影音', color: 'pink', collapsed: false },
    ],
    meta: {
      id: 'demo-home-v1',
      name: '示例 · 周末个人',
      env: 'home',
      envLabel: '个人',
      tags: ['示例', '周末'],
      browser: 'Edge',
      extensionVersion: '0.1.0',
      notes: '演示用快照。用于验证环境筛选与个人 / 办公切换。',
    },
    now: created,
  });
}

export function demoSnapshots(now = new Date()) {
  return [officeSnapshot(now), homeSnapshot(now)];
}

export function demoBundle(now = new Date()) {
  return {
    schema: 'tbas.bundle',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    generator: 'tbas demo',
    snapshots: demoSnapshots(now),
  };
}
