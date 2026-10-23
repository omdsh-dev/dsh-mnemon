---
"dsh-mnemon-source-memory-spaces": patch
"dsh-mnemon": patch
"dsh-mnemon-provider-hindsight": patch
"dsh-mnemon-provider-mem0": patch
"dsh-mnemon-provider-honcho": patch
"dsh-mnemon-provider-retaindb": patch
"dsh-mnemon-provider-supermemory": patch
"dsh-mnemon-provider-openviking": patch
"dsh-mnemon-provider-holographic": patch
"dsh-mnemon-provider-byterover": patch
---

A Memory Space can be **Read only** (#434). Choose it under **Writes** in the space's **Edit** dialog, below the Provider settings; the card then shows it.

- **What it stops.** DSH still recalls the space, but no write from DSH reaches its Provider. Remember, a batch of memories, forget, link, the task Agent's writes, MEMORY.md and Document index archival, and merging into the space are refused before the Provider is called, with an error that names the space. A read-only Mnemon Native space also keeps its Store, and **Fill in** adds no vectors to it. A merge or a fill checks again before each write it makes.
- **Where writes land.** The choice follows the place a space's writes land, not its card. That place is the Provider type and its service, then what the Provider names there, with its defaults resolved: a bank, a user and agent, a workspace and peers, a project and user, a container tag, an account and memory root, a store file, a folder, or a Store.
  - Each built-in Provider names its place through the new optional adapter method `namespaceKey`. A Provider without the method is keyed by its service alone, so read only covers every space on that service.
  - A space made by hand, one the strategy creates, a second Provider instance on the same server, a rediscovery, a reconnect or switching a space on gains no write.
  - Writable applies to the space's own place.
- **Writes that name no space** go to the one active writable space, never to a read-only one. With every space read only, a full MEMORY.md archives to the local archive file.
- **Recall evidence and page items** report what a read-only space takes now, so no Forget is offered there.
- **Where the choice is kept.** It is kept per data directory and per Source instance in `state/memory-provider-write-policy.json`, with at most 1,000 places. If the file, or an entry in it, cannot be read, every space is read only and recall keeps working. The page says why and offers **Reset write choices** behind a confirmation.
- **For integrations.** The Source management operation `body-write-policy` (`{ memoryBodyId, policy: 'writable' | 'read-only' }`, confirmed) sets the choice, and `body-write-policy-reset` clears it. The page client's `setWritePolicy` and `resetWritePolicy` call them. A read-only space carries `writePolicy: 'read-only'` in the directory and status.
- **No change without the choice.** Spaces without it behave as before.

记忆空间可以设为**只读**（#434）。在空间的**编辑**对话框中，于 Provider 设置下方的**写入**里选择；之后卡片上会显示。

- **它阻止什么。** DSH 仍会召回该空间，但不会有 DSH 的写入到达它的 Provider。存入、批量存入、遗忘、链接、任务 Agent 的写入、MEMORY.md 与文档索引的归档，以及合并进该空间，都会在调用 Provider 之前被拒绝，报错写明是哪个空间。只读的 Mnemon Native 空间还会保留它的 Store，**补齐**也不会为它生成向量。合并与补齐在每次写入前都会再检查一次。
- **写入的落点。** 设置跟随空间写入的落点，而不是卡片。落点先由 Provider 类型及其服务确定，再由 Provider 在其中指明的位置确定，默认值都已解析：bank、user 与 agent、workspace 与 peer、project 与 user、container tag、account 与记忆根、存储文件、目录或 Store。
  - 每个内置 Provider 都通过新增的可选适配器方法 `namespaceKey` 指明自己的落点。没有该方法的 Provider 只按服务确定落点，因此只读会覆盖该服务上的所有空间。
  - 手动创建的空间、策略新建的空间、同一服务器上的第二个 Provider 实例、重新发现、重新连接或打开开关，都不会带来写入。
  - 可写入只作用于该空间自己的落点。
- **未指定空间的写入**进入唯一一个已激活且可写的空间，不会写进只读空间；所有空间都只读时，写满的 MEMORY.md 归档到本地归档文件。
- **召回证据与页面条目**会反映只读空间当前的能力，因此那里不再提供“遗忘”。
- **设置保存在哪里。** 设置按数据目录、按 Source 实例保存在 `state/memory-provider-write-policy.json`，最多 1,000 个落点。该文件或其中的条目无法读取时，所有空间都按只读处理，召回照常；页面会说明原因，并在确认后提供**重置写入选择**。
- **供集成使用。** Source 管理操作 `body-write-policy`（`{ memoryBodyId, policy: 'writable' | 'read-only' }`，需确认）负责设置，`body-write-policy-reset` 负责清除；页面客户端的 `setWritePolicy` 与 `resetWritePolicy` 调用它们。只读空间在目录与状态中带有 `writePolicy: 'read-only'`。
- **没有设置时行为不变。** 没有设置的空间与以前完全相同。
