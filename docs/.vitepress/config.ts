import { defineConfig } from 'vitepress'
import { zhConfig } from './theme/zh'

export default defineConfig({
  lang: 'zh-CN',
  title: 'ConfDock',
  description: '管理原生配置，发布稳定订阅地址。',
  base: '/ConfDock/',
  cleanUrls: true,
  lastUpdated: true,
  titleTemplate: ':title · ConfDock',
  head: [
    ['link', { rel: 'icon', href: '/ConfDock/favicon.svg' }],
  ],
  themeConfig: {
    ...zhConfig,
    nav: [
      { text: '首页', link: '/' },
      { text: '使用指南', link: '/guide/introduction' },
      { text: '部署', link: '/deployment/binary' },
      { text: '运维', link: '/operations/backup-and-restore' },
      { text: '参考', link: '/reference/cli' },
      { text: '开发', link: '/development/architecture' },
      { text: 'GitHub', link: 'https://github.com/kure29/ConfDock' },
    ],
    sidebar: {
      '/guide/': [
        { text: '使用指南', items: [
          { text: '产品介绍', link: '/guide/introduction' },
          { text: '快速开始', link: '/guide/getting-started' },
          { text: '核心概念', link: '/guide/core-concepts' },
          { text: '托管地址', link: '/guide/hosted-addresses' },
        ] },
      ],
      '/deployment/': [
        { text: '部署', items: [
          { text: '二进制部署', link: '/deployment/binary' },
          { text: '配置文件', link: '/deployment/configuration' },
          { text: 'systemd', link: '/deployment/systemd' },
          { text: '反向代理', link: '/deployment/reverse-proxy' },
        ] },
      ],
      '/operations/': [
        { text: '运维', items: [
          { text: '备份与恢复', link: '/operations/backup-and-restore' },
          { text: '升级', link: '/operations/upgrade' },
          { text: '故障排查', link: '/operations/troubleshooting' },
        ] },
      ],
      '/reference/': [
        { text: '参考', items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'API', link: '/reference/api' },
          { text: '安全边界', link: '/reference/security' },
        ] },
      ],
      '/development/': [
        { text: '开发', items: [
          { text: '架构', link: '/development/architecture' },
          { text: '本地开发', link: '/development/local-development' },
          { text: 'ADR', items: [
            { text: 'Native Config 是事实来源', link: '/development/adr/ADR-001-native-config-source-of-truth' },
            { text: 'Target Adapter 隔离', link: '/development/adr/ADR-002-target-adapter-isolation' },
            { text: '保留原始字节', link: '/development/adr/ADR-003-source-preserving-editing' },
            { text: 'Served Revision 指针', link: '/development/adr/ADR-004-hidden-revisions-served-pointer' },
            { text: 'Draft / Publish 分离', link: '/development/adr/ADR-005-draft-publish-pointer-separation' },
          ] },
        ] },
      ],
    },
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/kure29/ConfDock/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页',
    },
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdatedText: '最后更新',
    returnToTopLabel: '返回顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    socialLinks: [{ icon: 'github', link: 'https://github.com/kure29/ConfDock' }],
  },
})
