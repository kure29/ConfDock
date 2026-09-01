# 核心概念

ConfDock 的界面围绕原生字节和两个 Revision 指针组织。理解下面的名词，就能看懂保存、发布和订阅之间的关系。

| 名词 | 含义 |
| --- | --- |
| Native Config | 某个客户端原生格式的原始字节，是唯一 Source of Truth。 |
| Project | 一个 Target、一份原生文档及其 Revision 历史。 |
| Revision | 不可变的已保存字节快照，带父版本、编号、哈希和校验快照。 |
| Current Revision | 管理界面当前工作的已保存草稿指针。 |
| Served Revision | Stable URL 实际返回的已发布版本指针。 |
| Save | 校验并创建新的 Current Revision（字节未变化时返回 `unchanged`）。 |
| Publish | 将选定的已保存 Revision 设为 Served；不创建 Revision、不改 Token。 |
| Stable URL | `/sub/:token` 订阅入口，只读取 Served Revision 的原始字节。 |
| Hosted Address | 对 Stable URL 的管理记录，包含名称、有效期、撤销状态和 Token Hash。 |

## Save 与 Publish 的关系

```text
编辑器内容
   │ Save
   ▼
Current Revision（草稿） ── Publish ──▶ Served Revision（对外）
                                      │
                                      ▼
                               Stable URL 返回的字节
```

Save 不会自动 Publish。只要两个指针不同，项目就有未发布变更；Stable URL 仍然返回旧的 Served Revision。Publish 使用两个 expected pointer 做并发保护，重复发布已经一致的指针是幂等成功。

## 原始字节为何重要

Revision 保存 SQLite BLOB，`/sub/:token` 直接返回该 BLOB，不转成 JSON 字符串、不重新序列化、不追加换行。BOM、LF/CRLF、尾部换行、注释、顺序和未知字段因此可以保持不变。结构化编辑只替换明确的 Source Span，无法安全定位时请使用 Raw Editor。

## 历史、Diff 与删除

历史列表默认返回最近 50 条，最多 100 条；详情按需读取一条 Revision 的原始字节。Diff 是同一 Project 内的只读行级比较，输入合计最多 8 MiB、200,000 行，输出最多 10,000 行。当前没有 Rollback、Revision 删除或 Token repointing。
