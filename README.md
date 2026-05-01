# MAGOL 在线 LLM 文字冒险平台

一个移动端友好的多人在线 LLM 文字冒险平台：登录注册、冒险大厅、创建/加入房间、房主开局、LLM 自动生成世界/角色/目标，并以“LLM 播报 ↔ 玩家决策”的 3 分钟回合循环推进剧情。

## 功能

- 用户登录/注册：用户名 + 密码，密码使用 bcrypt 哈希保存到 `data/users.json`。
- 实时大厅：创建房间、加入房间、房间状态同步展示。
- 持久化冒险桌：房间保存到 `data/rooms.json`，玩家离开或服务重启后仍保留；除非房主主动删除，否则会一直显示在大厅。
- 持久化进行中的游戏：进行中的冒险不会因为所有玩家离席而清空；当前世界、角色、物品、状态、回合和聊天都会保存。
- 暂停 / 继续：如果可行动真人玩家离席或断线、整回合没有任何真人提交行动，或当前只剩 LLM Bot 可自动推进，当前回合会强制暂停避免空转；玩家返回或提交行动后再继续。
- LLM Bot 队友：房主可在等待/已结束状态添加或移除 LLM Bot；Bot 会生成角色，回合中可先主动说话或询问 GM，再决定提交行动或进入待命；玩家说话可唤醒待命 Bot，也可让已提交但尚未结算的 Bot 撤回并调整行动；Bot 也能按信息权限回应聊天并可选择沉默，避免无限刷屏。
- 重新开始：已结束的冒险桌可以等待玩家重新凑齐后由房主重新开始。
- 房主开局方式：开始/重新开始时弹窗选择“全随机生成”“一句话描述生成”“详细设定参数”。
- 房主中止 / 删除：房主可在冒险中中止当前冒险（房间保留且状态变为已结束），也可永久删除冒险桌。
- LLM GM：按房主选择的开局方式生成游戏标题、背景设定、共同目标、每位玩家角色设定/个人目标/初始物品/状态标签/属性。
- 角色状态系统：默认生命值与体力；LLM 可按世界观添加魔力值、饱食度、氧气等自定义属性，并通过故事进展工具修改物品栏、状态标签、属性与空间位置；聊天内会用状态卡片直观展示变化。
- 行动限制：生命值耗尽会死亡；体力耗尽会力竭并可在未受伤时自然恢复；休克/昏迷等状态会无法行动且无法感知，通常需要外界唤醒或救助；世界观允许时，LLM 通过工具把生命值恢复到 >0 即可复活。
- 随机数工具：概率事件由服务器随机数工具 `roll_random` 结算，避免模型自行编造随机结果。
- 游戏模式：
  - 合作模式：玩家信息共享，围绕共同目标协作。
  - 独立模式：共同目标不变，但角色信息、说话、行动结果和局势播报按空间与个人视角隔离；结局由 LLM 评选 MVP。
  - PVP 模式：玩家目标由 LLM 分配且各不相同，可包含阵营对抗、间谍、隐藏身份或竞速胜利条件。
- 回合制决策：
  - 玩家提交本回合行动。
  - 每轮行动前，玩家可最多 3 次“询问 GM”以获取当前视角下有限、相关、不会推进剧情的信息。
  - 在 LLM 开始结算前，只要仍有其他可行动玩家未提交，已提交玩家可以撤回行动并重新提交。
  - 独立/PVP 模式下，“行动”私下提交给 GM，“说话”只会被同一空间的角色听见。
  - 全员提交后立即结算。
  - 或 3 分钟超时自动结算（若本回合没有真人行动则暂停避免空转）。
  - 聊天框顶部紧贴倒计时进度条。
- 游戏内界面：Discord-like 三栏布局（频道/玩家、聊天主面板、冒险档案），NEUBRUTALISM 风格，响应式移动端适配；手机端采用 ChatGPT-like 全屏聊天，队伍/档案放入左右抽屉侧栏；消息列表仅在贴底时自动滚动，离底时显示“↓ n 条新消息”胶囊按钮。
- Provider 配置：支持 OpenAI-compatible Chat Completions API；无 API Key 时自动使用本地 Mock，便于开发演示。

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

访问：<http://localhost:3000>

> 本地无 LLM Key 也可以运行：把 `.env` 中 `LLM_PROVIDER=mock`，或不填写 `LLM_API_KEY`。

## LLM Provider 配置

复制 `.env.example` 为 `.env` 后配置：

```env
PORT=3000
SESSION_SECRET=replace-with-a-long-random-string
TURN_TIMEOUT_MS=180000

LLM_PROVIDER=openai-compatible
LLM_API_KEY=your-api-key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_TEMPERATURE=0.85
LLM_TIMEOUT_MS=45000
LLM_MAX_RETRIES=3
LLM_THINKING_EFFORT=high
LLM_DEBUG_LOG=false
LLM_DEBUG_LOG_FILE=data/llm-debug.log
```

也可以配置 DeepSeek / OpenRouter / SiliconFlow 等 OpenAI-compatible 服务，只需修改 `LLM_BASE_URL` 与 `LLM_MODEL`。

LLM 调用失败时会自动重试 `LLM_MAX_RETRIES` 次；仍失败则暂停在当前阶段，不会切换到本地 Mock。开局失败可由房主再次点击开始，回合结算/Bot 行动失败可由房主点击“重试 LLM”。

排查 Provider / Prompt 问题时可设置 `LLM_DEBUG_LOG=true`：控制台会输出截断后的 LLM 请求/响应详情，`LLM_DEBUG_LOG_FILE` 指定的日志文件会写入未截断的完整请求/响应正文（不会记录 API Key，但仍可能包含完整剧情、玩家输入与角色秘密，请勿在生产环境随意开启或提交日志）。

## 项目结构

```text
.
├── server.js           # Express + Socket.IO 后端、房间与回合逻辑
├── src/
│   ├── llm.js          # LLM Provider 调用、Prompt、本地 Mock provider
│   └── store.js        # 简单 JSON 用户存储
├── public/
│   ├── index.html      # 单页应用结构
│   ├── styles.css      # NEUBRUTALISM + 移动端样式
│   └── app.js          # 前端状态、Socket.IO、渲染逻辑
├── data/               # 运行后生成 users.json / rooms.json
└── .env.example
```

## 回合规则

1. 房主点击“开始游戏”，在弹窗中选择全随机、一句话描述或详细设定参数。
2. 后端按所选开局方式调用 LLM 生成开局，并广播 GM 开场播报。
3. 进入第 1 回合：所有玩家提交行动；行动前每名玩家最多可询问 GM 3 次，GM 只按角色现状、感知能力、空间与已知信息给出有限回答；已提交者可在 LLM 结算开始前、且仍有其他可行动玩家未提交时撤回并重新提交。
4. 满足以下任一条件时结算：
   - 所有当前可行动角色（真人 + LLM Bot）都已提交行动，且本轮包含可行动真人玩家；
   - 倒计时达到 `TURN_TIMEOUT_MS`（默认 180000ms = 3 分钟），且本回合至少有真人玩家提交过行动。
   - 如果可行动真人玩家离席/断线、整回合没有真人回应，或当前只剩 LLM Bot 可推进，倒计时/结算会暂停，等待真人返回或提交行动。
5. 后端把玩家行动、超时玩家、无法行动玩家、最近消息、空间分组和服务器记录的角色状态发送给 LLM。
6. 如行动涉及概率，LLM 可调用服务器随机数工具 `roll_random`。
7. LLM 返回 GM 播报与 `storyProgressToolCalls`，后端据此修改角色属性、物品栏、状态标签与空间位置，并在聊天中生成可视化状态变化卡片。
8. 独立/PVP 模式下，LLM 必须为每名玩家返回单独视角播报；前端只显示该玩家应该听到/看到的信息。
9. 若 LLM 未宣告结局，进入下一回合；独立模式结局会显示 LLM 评选的 MVP。
10. 房主可在 `starting` / `playing` 阶段点击“中止冒险”，当前冒险变为已结束但房间、聊天、角色与档案保留。

## 生产部署提示

- 请务必设置强随机 `SESSION_SECRET`。
- 当前实现使用 JSON 文件保存用户与冒险桌，适合原型/小规模部署；生产环境建议替换为 Redis/数据库与持久化 session store。
- 如部署到 HTTPS 反向代理后，可按需给 session cookie 增加 `secure: true`。
