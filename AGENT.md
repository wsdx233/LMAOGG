# AGENT.md

面向后续编码 Agent 的项目速览与开发约定。

## 项目概览

MAGOL 是一个移动端友好的多人在线 LLM 文字冒险平台。用户登录后可在大厅创建/加入冒险桌，由房主选择开局生成方式与游戏模式，LLM 负责生成世界、角色、目标，并按“玩家提交行动 / LLM GM 结算”的回合循环推进剧情。

核心特性：

- 登录/注册，密码使用 bcrypt 哈希保存到本地 JSON。
- Express + Socket.IO 实时大厅、房间、聊天和回合状态同步。
- 房间与进行中冒险持久化到 `data/rooms.json`，服务重启后可恢复。
- OpenAI-compatible Chat Completions Provider；无 API Key 或 `LLM_PROVIDER=mock` 时使用本地 Mock。
- 支持合作、独立、PVP 三种信息权限模式。
- 支持 LLM Bot 队友、Bot 聊天回应、Bot 自动行动。
- 支持角色生命值、体力、自定义属性、状态标签、物品与空间位置变更。

## 技术栈与运行

- Node.js >= 18，ESM（`package.json` 中 `"type": "module"`）。
- 后端：`express`、`express-session`、`socket.io`、`bcryptjs`、`dotenv`。
- 前端：原生 HTML/CSS/JS 单页应用，Socket.IO client。
- 没有构建步骤、没有测试脚本、没有 lint 脚本。

常用命令：

```bash
npm install
cp .env.example .env
npm run dev     # node --watch server.js
npm start       # node server.js
```

测试时LLM：保持 `LLM_PROVIDER=mock`，或不填写 `LLM_API_KEY`。

## 目录结构

```text
.
├── server.js           # Express + Socket.IO 后端、房间/回合/持久化主逻辑
├── src/
│   ├── llm.js          # LLM Provider、Prompt、Mock、LLM 返回归一化、随机数工具
│   └── store.js        # 用户 JSON 存储（data/users.json）
├── public/
│   ├── index.html      # 单页应用 DOM 结构
│   ├── styles.css      # NEUBRUTALISM 风格与移动端响应式样式
│   └── app.js          # 前端状态管理、API、Socket.IO、渲染与交互
├── data/               # 运行期数据；users.json / rooms.json 被 .gitignore 忽略
├── README.md           # 用户向说明与功能说明
└── .env.example        # 环境变量示例
```

## 后端架构要点

`server.js` 是主入口：

- HTTP API：
  - `GET /api/me`
  - `POST /api/register`
  - `POST /api/login`
  - `POST /api/logout`
- Socket.IO 事件：
  - 房间：`room:create`、`room:join`、`room:leave`、`room:delete`
  - Bot：`room:bot:add`、`room:bot:remove`
  - 冒险：`room:start`、`room:end`、`llm:retry`
  - 回合/聊天：`turn:action`、`chat:send`
- 内存状态：
  - `rooms: Map<roomId, room>` 保存房间。
  - `userRooms: Map<userId, roomId>` 记录用户当前所在房间。
  - `userSockets: Map<userId, Set<socketId>>` 记录在线连接。
- 持久化：
  - 用户由 `src/store.js` 管理，写入 `data/users.json`。
  - 房间由 `server.js` 读写 `data/rooms.json`。
  - 保存时要把 `Map` / turn actions 等转换为可 JSON 序列化结构；恢复时再 rehydrate。

修改房间/回合逻辑时，注意同时维护：

1. 内存状态。
2. `serializeRoom()` / `serializeLobbyRoom()` 给前端的视图数据。
3. `serializeRoomForPersistence()` / `rehydrateTurn()` 的持久化兼容性。
4. `emitRoom()` / `emitLobby()` 与 `scheduleSaveRooms()`。

## 回合与信息权限

状态流大致为：

```text
waiting/ended --room:start--> starting --LLM setup--> playing --gameOver/end--> ended
```

回合流程：

1. `startGame()` 调用 `generateGameSetup()` 生成标题、设定、目标、角色状态和开场。
2. `beginTurn()` 创建 `currentTurn`，设置 3 分钟倒计时（由 `TURN_TIMEOUT_MS` 配置）。
3. 真人通过 `turn:action` 提交行动；Bot 由 `submitBotActions()` 调用 LLM 生成行动。
4. 全员提交或超时后 `resolveTurn()` 调用 `generateTurnNarration()`。
5. GM 播报后，`applyStoryToolCalls()` 根据 LLM 返回的 `updateCharacter` 工具调用更新角色属性、物品、状态标签与位置。
6. 未结束则进入下一回合；结束则房间状态变为 `ended`。

独立 / PVP 模式属于私密信息模式：

- 行动只对本人和 GM 可见。
- 聊天变为同空间可听见的 `say`。
- `serializeRoom()` 会按 viewer 过滤角色信息、消息、空间与回合提交状态。
- LLM 必须返回每名玩家的 `privateNarrations`，不能泄露其他空间或秘密目标。

## LLM 模块约定

`src/llm.js` 对外导出：

- `generateGameSetup(players, setupOptions)`
- `generateTurnNarration({ room, actions, timedOutUsers, unableUsers, recentMessages })`
- `generateBotAction({ room, bot, recentMessages })`
- `generateBotChatReply({ room, bot, triggerMessage, recentMessages })`
- `getTurnTimeoutMs()`

Provider 行为：

- 默认根据 `LLM_PROVIDER` / `LLM_API_KEY` 决定使用 OpenAI-compatible 或 Mock。
- OpenAI-compatible 调用 `/chat/completions`，要求 JSON 输出。
- 支持 `reasoning_effort`；如果 Provider 拒绝会自动去掉该参数重试。
- 回合结算支持服务器端 `roll_random` 工具；如果 Provider 不支持 tools，会自动去掉 tools 重试。
- LLM 连续失败后不回退 Mock，而是标记错误并暂停，等待房主重试。

改 Prompt 或返回 schema 时，务必同步：

- `normalizeSetup()` / `normalizeTurn()` / `normalizeStoryToolCalls()`。
- `applyStoryToolCalls()` 可识别和真正落库的字段。
- 前端状态卡片和档案渲染逻辑。

## 前端约定

前端在 `public/app.js` 中维护一个全局 `state` 和 `dom` 引用：

- 登录/注册走 HTTP API。
- 登录成功后创建 Socket.IO 连接并监听 `lobby:update`、`room:update`。
- 所有房间/回合操作通过 Socket 事件发出，并使用 ack 显示错误。
- 移动端使用左右抽屉；聊天列表贴底时自动滚动，离底时显示新消息按钮。

改 DOM 结构时需要同步三处：

1. `public/index.html` 中元素 id。
2. `public/app.js` 的 `dom` 映射和相关事件绑定。
3. `public/styles.css` 的桌面/移动端样式。

## 数据与安全注意事项

- 不要提交 `.env`、`data/users.json`、`data/rooms.json`、`node_modules/`。
- `data/*.json` 是运行期状态，调试时可删除以重置本地数据。
- 生产部署必须设置强随机 `SESSION_SECRET`。
- 当前使用 JSON 文件和内存 session，适合原型/小规模部署；生产环境应替换为数据库/Redis 与持久化 session store。
- `.env.example` 中可新增配置说明，但不要写真实 Key。

## 开发检查清单

改动后至少执行：

```bash
node --check server.js
node --check src/llm.js
node --check src/store.js
node --check public/app.js
```

如改动前端交互或回合流程，建议再用 Mock Provider 手动验证：

1. 启动 `npm run dev`。
2. 注册/登录用户。
3. 创建房间、添加 Bot、选择不同游戏模式开始。
4. 提交聊天和行动，确认回合能结算、状态变化能显示、刷新/重启后房间能恢复。

## 常见坑

- `rooms`、`players`、`currentTurn.actions` 在内存中是 `Map`；持久化与前端序列化都需要显式转换。
- 私密信息模式下，不能把完整玩家信息直接广播给所有人；优先检查 `serializeRoom()` 和 `messagesForViewer()`。
- 角色生命/体力规则集中在 `applyVitalsRules()`、`getPlayerCondition()`、`canPlayerAct()`、`canPlayerPerceive()`；新增状态标签要考虑是否影响行动或感知。
- LLM 叙事里的状态变化不会自动生效，必须通过 `storyProgressToolCalls` 进入 `applyStoryToolCalls()`。
- 回合暂停/恢复逻辑要避免只有 Bot 空转：无真人可行动、真人离席、整回合无人类提交时应暂停。
- 增加 Socket 事件时要做鉴权、房主权限检查、ack 错误返回，并在必要时 `emitRoom()` / `emitLobby()`。
