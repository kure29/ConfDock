---
layout: home

hero:
  name: ConfDock
  text: 管理原生配置，发布稳定订阅地址。
  tagline: 自托管、保留原始字节的配置管理服务。Save 与 Publish 分离，让草稿先审阅再对外提供。
  actions:
    - theme: brand
      text: 开始使用
      link: /guide/getting-started
    - theme: alt
      text: 查看 GitHub
      link: https://github.com/kure29/ConfDock

features:
  - title: 原始字节保真
    details: 保留 BOM、行尾、注释、顺序和未知字段；结构化编辑只做明确的局部 Source Span Patch。
  - title: Revision 历史
    details: 每次保存变成不可变 Revision，可分页查看元数据并只读比较，不覆盖正在编辑的内容。
  - title: Draft / Publish 分离
    details: Save 只推进 Current Revision；Publish 才推进 Served Revision，Stable URL 不会泄露草稿。
  - title: 自托管稳定地址
    details: SQLite 与单管理员服务运行在自己的 Linux 主机上，Hosted Address 通过高熵 Token 提供订阅入口。
---

<div class="home-note">
  <strong>当前文档以简体中文为主。</strong> ConfDock 目前没有正式 Release；请从仓库的 Actions 手动构建并下载临时 Artifact。
</div>
