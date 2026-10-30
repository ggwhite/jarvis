import type { EngineInterface } from 'claude-code'

export type Locale = 'zh-TW' | 'en'

const zhTW = {
  // ---- shared words ----
  'common.back': '返回',
  'common.jump': '跳轉',
  'common.refresh': '重新整理',
  'common.resume': '繼續',
  'common.pause': '暫停',
  'common.loading': '讀取中…',
  'common.computing': '計算中…',
  'common.binary': '二進位',
  'common.none': '（無）',
  'common.other': '其他',
  'common.main': '主線',
  'common.unpriced': '未計價',
  'common.noId': '(無 id)',
  'common.more': '… 還有 {n} 個',
  'common.runs': '{n} 次',
  'common.avg': '平均 {v}',
  'common.listSep': '、',

  // ---- tabs and page titles ----
  'tab.now': '現況',
  'tab.log': '事件流',
  'tab.stats': '統計',
  'tab.fleet': '艦隊',
  'tab.changes': '異動',
  'tab.tasks': '任務',
  'title.subagents': '子代理',
  'title.inflight': '進行中',
  'title.recent': '最近事件',
  'title.dispatchLog': '派工紀錄',
  'title.quota': '額度',
  'title.noChanges': '沒有異動',

  // ---- the reactor and backdrop pictures ----
  'alt.reactorOn': '反應爐運轉中',
  'alt.reactorOff': '反應爐待機',
  'alt.backdrop': '背景',
  'alt.lastHourOf': '{label} 最近一小時',
  'alt.lastHour': '最近一小時',
  'alt.hourlyToday': '今日每小時',
  'alt.herdrOff': 'herdr 未連線',

  // ---- the main line and the squad ----
  'main.running': '● 執行中',
  'main.working': '● 運作中',
  'main.idle': '○ 閒置',
  'squad.empty': '還沒有派工。派出 subagent 後這裡會即時顯示。',
  'squad.running': '執行中 ({n})',
  'squad.stale': '失聯 ({n})',
  'squad.finished': '已完成 ({n})',
  'squad.headRunning': '▶{n} 執行中',
  'squad.headDone': '{n} 完成',
  'squad.headFailed': '{n} 失敗',
  'squad.headStale': '?{n} 失聯',
  'squad.desktopHead': '▶{n} 執行中 · {done} 完成',
  'squad.moreRows': '… 還有 {n} 列未顯示',
  'wf.agents': '{n} 個',
  'wf.running': '執行中',
  'wf.done': '完成',
  'wf.failed': '失敗',
  'wf.stale': '失聯',
  'inflight.idle': '目前沒有執行中的工具呼叫',
  'inflight.count': '{n} 個',

  // ---- the stats page ----
  'stats.moreKinds': '… 還有 {n} 種',
  'stats.noPriced': '沒有可計價的模型',
  'stats.noSubagents': '還沒有 subagent',
  'stats.noModelUsage': '還沒有模型用量',
  'stats.modelTable': '| 模型 | 比例 | 次數 |',
  'stats.dispatches': '{n} 次派工',
  'role.empty': '這個角色還沒有派工',

  // ---- a subagent's detail ----
  'field.type': '類型',
  'field.model': '模型',
  'field.status': '狀態',
  'field.task': '任務',
  'field.started': '開始',
  'field.elapsed': '耗時',
  'field.cache': '快取',
  'field.workspace': '工作區',
  'field.dir': '目錄',
  'field.idle': '閒置',
  'field.today': '今日',
  'field.recentTools': '近期工具',
  'field.lastPrompt': '最後提問',
  'field.lastReply': '最後回覆',
  'detail.tokens': '輸入 {input} · 輸出 {output}',
  'detail.cacheRead': '讀取 {n}',
  'detail.cacheWrite': '寫入 {n}',
  'detail.agentIndex': ' · 第 {n} 個',

  // ---- event lists ----
  'log.noCalls': '還沒有工具呼叫',
  'log.paused': '⏸ 已暫停 · 新增 {n} 則',
  'log.total': '{total}/{max} 則',
  'log.count': '{n} 則',
  'log.thisSubagent': ' · 這個 subagent',
  'log.subagentNoCalls': '這個 subagent 還沒有工具呼叫',
  'col.time': '時間',
  'col.who': '誰',
  'col.tool': '工具',
  'col.desc': '描述',
  'col.took': '耗時',
  'col.result': '結果',

  // ---- the fleet ----
  'fleet.scanning': '掃描艦隊中…',
  'fleet.empty': '艦隊目前沒有 Claude session',
  'fleet.moreSuits': '… 還有 {n} 艘',
  'fleet.needsHerdr': '需要 herdr：艦隊頁從 herdr 讀取所有 Claude session',
  'fleet.needsHerdrShort': '需要 herdr',
  'fleet.herdrHint': '在 herdr 裡執行 Claude Code（HERDR_ENV=1）後，這裡會列出每個 session 的狀態、今日用量與額度。',
  'fleet.toolCount': '{n} 次工具',
  'fleet.tools': '{n} 次',
  'fleet.suits': ' 艘',
  'fleet.retirable': ' 艘可退役',
  'fleet.jumpFailed': '跳轉失敗：{why}',
  'fleet.herdrNoReply': 'herdr 沒有回應',

  // ---- the changes page ----
  'changes.modeSession': '本次 session',
  'changes.modeSessionShort': '本 session',
  'changes.modeUnpushed': '未推送',
  'changes.modeCommits': '提交',
  'changes.files': '{n} 檔',
  'changes.moreFiles': '… 還有 {n} 檔',
  'changes.moreLines': '… 還有 {n} 行',
  'changes.noFiles': '這個 session 還沒改過檔案',
  'changes.noRepos': '這個 session 還沒碰過任何 git repo',
  'changes.removedNamed': '{name} 已移除（{n} 檔）',
  'changes.removed': '已移除（{n} 檔）',
  'changes.noUnpushed': '沒有未推送的改動',
  'changes.noDiff': '沒有差異',
  'changes.deleted': '已刪除',
  'changes.vsHead': '對 HEAD',
  'changes.untracked': ' (新)',
  'changes.notGit': '(非 git)',

  // ---- repos, commits, branches, stashes, worktrees ----
  'repo.scanning': '掃描 repo 中…',
  'repo.notFound': '找不到 repo',
  'repo.more': '… 還有 {n} 個 repo',
  'repo.viewCommits': '提交',
  'repo.viewBranches': '分支',
  'repo.noCommits': '這個 repo 還沒有 commit',
  'remote.loading': '讀取 remote 中…',
  'remote.none': '沒有 remote',
  'remote.more': '還有 {n} 個 remote',
  'remote.neverFetched': '從未 fetch',
  'remote.fetching': 'fetch 中…',
  'branch.none': '沒有分支',
  'branch.noUpstream': '無 upstream',
  'branch.merged': '已 merge',
  'branch.more': '還有 {n} 個分支',
  'branch.active': '進行中 {n}',
  'branch.remoteOnly': '只在遠端',
  'branch.count': '{n} 個',
  'branch.goneNote': '（遠端已刪，多半已 merge）',
  'stash.shared': 'stash 由這個 repo 的所有 worktree 共用',
  'stash.none': '沒有 stash',
  'stash.noFiles': '這個 stash 沒有檔案',
  'worktree.none': '沒有 worktree',
  'worktree.missing': '已不存在',
  'worktree.clean': '乾淨',
  'commit.noFiles': '這個 commit 沒有改檔案',

  // ---- relative time ----
  'time.justNow': '剛剛',
  'time.minutesAgo': '{n} 分鐘前',
  'time.hoursAgo': '{n} 小時前',
  'time.yesterday': '昨天',
  'time.daysAgo': '{n} 天前',
  'time.monthsAgo': '{n} 個月前',
  'time.yearsAgo': '{n} 年前',

  // ---- git errors ----
  'err.failed': '{what} 失敗',
  'err.fetchTimeout': 'fetch 逾時',
  'err.noOriginal': '無原始內容',
  'err.noOrigin': '找不到 origin，只比 HEAD',
  'err.mergeBase': 'merge-base 失敗，只比 HEAD',
  'err.boardWrite': '看板暫時無法寫入',

  // ---- cost ----
  'cost.saved': '省{pct}%',
  'cost.over': '多花{pct}%',
  'cost.summary': '{models} · ≈{cost} vs Opus {opus}（{tail}）',
  'health.loop': '⚠繞圈 ',
  'health.stuck': '⚠卡住 ',

  // ---- /jarvis ----
  'pane.rcNote': 'Remote Control 的 Desktop／手機檢視目前不顯示 mod 面板，請在終端機或 Desktop 本機 session 查看',
  'pane.openFailed': 'Jarvis 面板開啟失敗',
  'pane.opened': 'Jarvis 面板已開啟',
  'pane.openedTerminal': 'Jarvis 面板已在終端機開啟（{note}）',
  'pane.noSurface': '沒有可放面板的畫面',
  'pane.noRoom': '畫面暫時放不下面板，條件滿足後會自動顯示（引擎原因：{reason}）',
  'pane.notPlaced': 'Jarvis 面板已開啟，但還沒放上畫面：{why}',
  'pane.notPlacedNote': 'Jarvis 面板已開啟，但還沒放上畫面：{why}（{note}）',

  // ---- the task board, as drawn ----
  'tasks.empty': '還沒有任務。送出請求後，這裡會列出正在做、預計要做和做完的事。',
  'tasks.running': '進行中',
  'tasks.planned': '預計',
  'tasks.done': '已完成',
  'tasks.wordRunning': '進行中',
  'tasks.wordPlanned': '預計',
  'tasks.wordDone': '完成',
  'tasks.moreRows': '還有 {n} 列',
  'tasks.moreAbove': '上面還有 {n} 列',
  'tasks.counts': '{itemsDone}/{items} 項目 · 細項 {subtasksDone}/{subtasks}',
  'tasks.builtin': '內建任務',
  'member.waiting': '等待',
  'member.done': '完成',
  'member.failed': '失敗',
  'member.stale': '失聯',

  // ---- the task board, as the model reads it ----
  'board.empty': '任務看板是空的。',
  'board.head': '任務看板（{counts}）',
  'board.current': '（本輪請求）',
  'board.notFound': '找不到 {id}：id 是項目（如 "2"）或細項（如 "2.3"）',
  'board.itemNotFound': '找不到項目 {id}',
  'board.toNeedsSubtasks': 'add 帶 to 時，subtasks 至少要有一個細項',
  'board.maxSubtasks': '一個項目最多 {max} 個細項',
  'board.addNeeds': 'add 要帶 item（新項目標題）或 to（既有項目 id）',
  'board.maxItems': '看板最多 {max} 個項目，先 remove 用不到的項目',
  'board.badStatus': 'status 只能是 pending、in_progress、completed',
  'board.emptyTitle': 'title 不能是空的',
  'board.itemUpdateNeeds': 'update 項目要帶 status 或 title',
  'board.itemHasSubtasks': '項目 {id} 有細項，狀態由細項決定；請 update 細項',
  'board.subUpdateNeeds': 'update 細項要帶 status、title 或 agent',
  'board.badOp': 'op 只能是 {ops}',
  'board.requestContext':
    'jarvis 任務看板：這個請求已記成項目 {id}，標題會自動摘成一句。這輪有呼叫工具或掛了細項，回覆結束時自動標完成並記下結果（有細項的，等細項全部完成才記結果）；只是回答問題，答完會自動移除。多步工作用 mcp__jarvis__task add 只帶 subtasks，把細項掛到這個項目；摘要不對時，用 update id={id} 帶 title 改。',

  // ---- the board's instructions in the system prompt ----
  'prompt.head': '# 任務看板',
  'prompt.intro':
    '使用者在 jarvis 面板的「任務」分頁看這個 session 正在做、預計要做、做完的事。jarvis 會把使用者送出的每個請求自動記成一個進行中的項目，回覆結束時自動標完成；只回答、沒有呼叫工具也沒有細項的請求，答完會自動移除。你用 mcp__jarvis__task 補上計畫。',
  'prompt.plan':
    '- 多步工作（三步以上，或會派 subagent）開始前，用 add 列出細項：只帶 subtasks 會掛到本輪請求；帶 item 時，本輪請求還沒有細項就直接併入它（標題換成 item），不會多一個項目。',
  'prompt.mark': '- 開始做一個細項時標 in_progress，做完立刻標 completed，不要留到最後一起標。',
  'prompt.title': '- 請求項目的標題由 jarvis 自動摘成一句，回覆結束時記下結果（有細項的請求，等細項全部完成才記）；摘得不對時，用 update 帶 title 改。',
  'prompt.later': '- 之後要做、這輪不做的事：用 add 只帶 item（不帶 subtasks），記成預計項目。',
  'prompt.change': '- 計畫變了就 add 新細項，或 remove 用不到的。',
  'prompt.agent': '- 派 subagent 做某個細項後，用 update 帶 agent（Agent 工具回傳的 agentId）。',
  'prompt.subagent': '- 你是 subagent 時，只 update 交給你的細項，不新增工作項目。',
  'prompt.single': '- 一問一答不用拆細項。',

  // ---- the board's tool ----
  'tool.intro': '維護本 session 的任務看板（jarvis 面板「任務」分頁）。兩層：工作項目（id 如 "2"）→ 細項（id 如 "2.3"）。',
  'tool.add':
    'op=add：item 建新項目，可同時帶 subtasks；或 to=既有項目 id，把 subtasks 加進去；不帶 item 和 to、只帶 subtasks 時，掛到本輪請求項目。帶 item 和 subtasks、本輪請求項目還沒有細項時，併入本輪請求項目（標題換成 item）。只帶 item 是預計項目。',
  'tool.update':
    'op=update：id 指項目或細項，帶 status（pending／in_progress／completed）、title 或 agent（負責這個細項的 subagent 的 agentId）。有細項的項目狀態由細項推出，把它標 completed 會把細項全部標 completed。',
  'tool.remove': 'op=remove：刪除 id 指的項目或細項。',
  'tool.list': 'op=list：回傳整張看板。',
  'tool.reply': '每次成功都回傳更新後的看板。',
  'tool.item': 'add：新工作項目的標題',
  'tool.to': 'add：要加細項的既有項目 id',
  'tool.subtasks': 'add：細項標題，依執行順序',
  'tool.id': 'update／remove：項目 id（"2"）或細項 id（"2.3"）',
  'tool.title': 'update：新標題',
  'tool.agent': 'update：負責這個細項的 subagent 的 agentId',

  // ---- the small model's asks ----
  'sum.system': '你替一個工作看板寫一行摘要。只回那一行繁體中文：不加引號、不加句號、不加「標題：」之類的前綴，也不解釋，也不用 → × — – 這類符號或彎引號。',
  'sum.result': '用不超過 {max} 個字寫出這個請求的結果或結論，例如「42」「比較後交換的無鎖原子更新」「已合併進 master」。\n\n請求：\n{prompt}{subtasks}\n\n回答：\n{answer}',
  'sum.subtasks': '\n\n細項：\n{list}',
  'cls.system': '你替一個工作看板整理請求。照指示的行數回繁體中文：不加引號、不加句號、不加「標題：」之類的前綴，也不解釋，也不用 → × — – 這類符號或彎引號。',
  'cls.noTopics': '（還沒有）',
  'cls.topic': '{id} {title}（最近的請求：{latest}）',
  'cls.last': '上一個請求：{title}{topic}\n\n',
  'cls.lastTopic': '（話題 {id}）',
  'cls.title': '用不超過 {max} 個字寫出這個請求要做什麼，動詞開頭，例如「計算 7*6」「解釋 CAS」「修 jarvis 的高亮」。',
  'cls.which': '再判斷它屬於下面哪個話題。',
  'cls.twoLines': '只回兩行：',
  'cls.line1': '第一行：請求標題。',
  'cls.line2': '第二行：屬於既有話題就回話題編號（只回數字）；都不屬於就回「新 」加上不超過 {max} 個字的話題名稱，例如「新 Jamie 七日簽到累計充值」。',
  'cls.short': '很短的請求（例如「確認送出」「好」「1」「push」）通常接續前一個請求的話題。',
  'cls.topics': '既有話題（最近活動的在前）：\n{topics}',
  'cls.request': '{last}請求：\n{prompt}',
} as const satisfies Record<string, string>

export type MsgKey = keyof typeof zhTW

// every key zh-TW has, and no other: the compiler holds the two to the same set
const en: Record<MsgKey, string> = {
  'common.back': 'Back',
  'common.jump': 'Jump',
  'common.refresh': 'Refresh',
  'common.resume': 'Resume',
  'common.pause': 'Pause',
  'common.loading': 'Loading…',
  'common.computing': 'Computing…',
  'common.binary': 'binary',
  'common.none': '(none)',
  'common.other': 'Other',
  'common.main': 'Main',
  'common.unpriced': 'unpriced',
  'common.noId': '(no id)',
  'common.more': '… {n} more',
  'common.runs': '×{n}',
  'common.avg': 'avg {v}',
  'common.listSep': ', ',

  'tab.now': 'Now',
  'tab.log': 'Events',
  'tab.stats': 'Stats',
  'tab.fleet': 'Fleet',
  'tab.changes': 'Changes',
  'tab.tasks': 'Tasks',
  'title.subagents': 'Subagents',
  'title.inflight': 'In flight',
  'title.recent': 'Recent events',
  'title.dispatchLog': 'Dispatch log',
  'title.quota': 'Quota',
  'title.noChanges': 'No changes',

  'alt.reactorOn': 'Reactor running',
  'alt.reactorOff': 'Reactor on standby',
  'alt.backdrop': 'Backdrop',
  'alt.lastHourOf': '{label} over the last hour',
  'alt.lastHour': 'Last hour',
  'alt.hourlyToday': 'Hourly today',
  'alt.herdrOff': 'herdr not connected',

  'main.running': '● Running',
  'main.working': '● Working',
  'main.idle': '○ Idle',
  'squad.empty': 'Nothing dispatched yet. Subagents show up here live once dispatched.',
  'squad.running': 'Running ({n})',
  'squad.stale': 'Lost ({n})',
  'squad.finished': 'Finished ({n})',
  'squad.headRunning': '▶{n} running',
  'squad.headDone': '{n} done',
  'squad.headFailed': '{n} failed',
  'squad.headStale': '?{n} lost',
  'squad.desktopHead': '▶{n} running · {done} done',
  'squad.moreRows': '… {n} more {n|row|rows} not shown',
  'wf.agents': '{n} {n|agent|agents}',
  'wf.running': 'running',
  'wf.done': 'done',
  'wf.failed': 'failed',
  'wf.stale': 'lost',
  'inflight.idle': 'No tool calls running',
  'inflight.count': '{n} {n|call|calls}',

  'stats.moreKinds': '… {n} more',
  'stats.noPriced': 'No priced models',
  'stats.noSubagents': 'No subagents yet',
  'stats.noModelUsage': 'No model usage yet',
  'stats.modelTable': '| Model | Share | Count |',
  'stats.dispatches': '{n} {n|dispatch|dispatches}',
  'role.empty': 'Nothing dispatched to this role yet',

  'field.type': 'Type',
  'field.model': 'Model',
  'field.status': 'Status',
  'field.task': 'Task',
  'field.started': 'Started',
  'field.elapsed': 'Elapsed',
  'field.cache': 'Cache',
  'field.workspace': 'Wkspace',
  'field.dir': 'Dir',
  'field.idle': 'Idle',
  'field.today': 'Today',
  'field.recentTools': 'Tools',
  'field.lastPrompt': 'Prompt',
  'field.lastReply': 'Reply',
  'detail.tokens': 'in {input} · out {output}',
  'detail.cacheRead': 'read {n}',
  'detail.cacheWrite': 'write {n}',
  'detail.agentIndex': ' · #{n}',

  'log.noCalls': 'No tool calls yet',
  'log.paused': '⏸ Paused · {n} new',
  'log.total': '{total}/{max} {max|event|events}',
  'log.count': '{n} {n|event|events}',
  'log.thisSubagent': ' · this subagent',
  'log.subagentNoCalls': 'This subagent has made no tool calls yet',
  'col.time': 'Time',
  'col.who': 'Who',
  'col.tool': 'Tool',
  'col.desc': 'Description',
  'col.took': 'Took',
  'col.result': 'Out',

  'fleet.scanning': 'Scanning the fleet…',
  'fleet.empty': 'No Claude sessions in the fleet',
  'fleet.moreSuits': '… {n} more',
  'fleet.needsHerdr': 'Needs herdr: the fleet page reads every Claude session from herdr',
  'fleet.needsHerdrShort': 'Needs herdr',
  'fleet.herdrHint': "Run Claude Code inside herdr (HERDR_ENV=1) and each session's status, today's usage and quota are listed here.",
  'fleet.toolCount': '{n} tool {n|call|calls}',
  'fleet.tools': '{n} {n|call|calls}',
  'fleet.suits': ' {n|suit|suits}',
  'fleet.retirable': ' retirable',
  'fleet.jumpFailed': 'Jump failed: {why}',
  'fleet.herdrNoReply': 'herdr did not respond',

  'changes.modeSession': 'This session',
  'changes.modeSessionShort': 'This session',
  'changes.modeUnpushed': 'Unpushed',
  'changes.modeCommits': 'Commits',
  'changes.files': '{n} {n|file|files}',
  'changes.moreFiles': '… {n} more {n|file|files}',
  'changes.moreLines': '… {n} more {n|line|lines}',
  'changes.noFiles': 'No files changed in this session yet',
  'changes.noRepos': 'No git repo touched in this session yet',
  'changes.removedNamed': '{name} removed ({n} {n|file|files})',
  'changes.removed': 'Removed ({n} {n|file|files})',
  'changes.noUnpushed': 'No unpushed changes',
  'changes.noDiff': 'No differences',
  'changes.deleted': 'deleted',
  'changes.vsHead': 'vs HEAD',
  'changes.untracked': ' (new)',
  'changes.notGit': '(not git)',

  'repo.scanning': 'Scanning repos…',
  'repo.notFound': 'No repo found',
  'repo.more': '… {n} more {n|repo|repos}',
  'repo.viewCommits': 'Commits',
  'repo.viewBranches': 'Branches',
  'repo.noCommits': 'This repo has no commits yet',
  'remote.loading': 'Loading remotes…',
  'remote.none': 'No remotes',
  'remote.more': '{n} more {n|remote|remotes}',
  'remote.neverFetched': 'never fetched',
  'remote.fetching': 'fetching…',
  'branch.none': 'No branches',
  'branch.noUpstream': 'no upstream',
  'branch.merged': 'merged',
  'branch.more': '{n} more {n|branch|branches}',
  'branch.active': 'Active {n}',
  'branch.remoteOnly': 'Remote only',
  'branch.count': '{n}',
  'branch.goneNote': ' (deleted on the remote, most likely merged)',
  'stash.shared': 'Stashes are shared by every worktree of this repo',
  'stash.none': 'No stashes',
  'stash.noFiles': 'This stash has no files',
  'worktree.none': 'No worktrees',
  'worktree.missing': 'missing',
  'worktree.clean': 'clean',
  'commit.noFiles': 'This commit changed no files',

  'time.justNow': 'just now',
  'time.minutesAgo': '{n}m ago',
  'time.hoursAgo': '{n}h ago',
  'time.yesterday': 'yesterday',
  'time.daysAgo': '{n}d ago',
  'time.monthsAgo': '{n}mo ago',
  'time.yearsAgo': '{n}y ago',

  'err.failed': '{what} failed',
  'err.fetchTimeout': 'fetch timed out',
  'err.noOriginal': 'No original content',
  'err.noOrigin': 'No origin found; comparing with HEAD only',
  'err.mergeBase': 'merge-base failed; comparing with HEAD only',
  'err.boardWrite': 'The board cannot be written right now',

  'cost.saved': 'saved {pct}%',
  'cost.over': '{pct}% over',
  'cost.summary': '{models} · ≈{cost} vs Opus {opus} ({tail})',
  'health.loop': '⚠looping ',
  'health.stuck': '⚠stuck ',

  'pane.rcNote': "Remote Control's Desktop/mobile views do not show mod panes yet; check the terminal or a local Desktop session",
  'pane.openFailed': 'Failed to open the Jarvis pane',
  'pane.opened': 'Jarvis pane opened',
  'pane.openedTerminal': 'Jarvis pane opened in the terminal ({note})',
  'pane.noSurface': 'there is no screen to place the pane on',
  'pane.noRoom': 'the screen has no room for the pane right now; it shows up once there is (engine reason: {reason})',
  'pane.notPlaced': 'Jarvis pane opened but not placed on screen yet: {why}',
  'pane.notPlacedNote': 'Jarvis pane opened but not placed on screen yet: {why} ({note})',

  'tasks.empty': 'No tasks yet. Send a request and its work is listed here.',
  'tasks.running': 'In progress',
  'tasks.planned': 'Planned',
  'tasks.done': 'Done',
  'tasks.wordRunning': 'Active',
  'tasks.wordPlanned': 'Later',
  'tasks.wordDone': 'Done',
  'tasks.moreRows': '{n} more {n|row|rows}',
  'tasks.moreAbove': '{n} more {n|row|rows} above',
  'tasks.counts': '{itemsDone}/{items} items · subtasks {subtasksDone}/{subtasks}',
  'tasks.builtin': 'Built-in tasks',
  'member.waiting': 'wait',
  'member.done': 'done',
  'member.failed': 'fail',
  'member.stale': 'lost',

  'board.empty': 'The task board is empty.',
  'board.head': 'Task board ({counts})',
  'board.current': ' (current request)',
  'board.notFound': 'Not found: {id}. An id names an item (like "2") or a subtask (like "2.3")',
  'board.itemNotFound': 'Item {id} not found',
  'board.toNeedsSubtasks': 'add with to needs at least one subtask in subtasks',
  'board.maxSubtasks': 'An item holds at most {max} subtasks',
  'board.addNeeds': 'add needs item (a new item title) or to (an existing item id)',
  'board.maxItems': 'The board holds at most {max} items; remove items you no longer need first',
  'board.badStatus': 'status must be pending, in_progress or completed',
  'board.emptyTitle': 'title cannot be empty',
  'board.itemUpdateNeeds': 'update on an item needs status or title',
  'board.itemHasSubtasks': 'Item {id} has subtasks, so its status follows them; update the subtasks instead',
  'board.subUpdateNeeds': 'update on a subtask needs status, title or agent',
  'board.badOp': 'op must be one of {ops}',
  'board.requestContext':
    'jarvis task board: this request is recorded as item {id}, and its title will be summarized into one line automatically. If this turn calls tools or adds subtasks, the item is marked done and its result recorded when the reply ends (with subtasks, the result is recorded only once all of them are done); if it only answers a question, it is removed once answered. For multi-step work, use mcp__jarvis__task add with only subtasks to hang them under this item; if the summary is wrong, fix it by calling update id={id} with title.',

  'prompt.head': '# Task board',
  'prompt.intro':
    'The user watches what this session is doing, has planned and has done in the "Tasks" tab of the jarvis pane. jarvis records every request the user sends as an in-progress item automatically and marks it done when the reply ends; a request that is only answered, with no tool calls and no subtasks, is removed once answered. You fill in the plan with mcp__jarvis__task.',
  'prompt.plan':
    '- Before multi-step work (three or more steps, or work that dispatches subagents), list the subtasks with add: subtasks alone hang under the current request; with item, if the current request has no subtasks yet, the plan merges into it (its title becomes item) instead of adding another item.',
  'prompt.mark': '- Mark a subtask in_progress when you start it and completed as soon as it is done; do not leave the marking until the end.',
  'prompt.title':
    "- jarvis summarizes each request item's title into one line automatically and records the result when the reply ends (for a request with subtasks, only once all of them are done); if the summary is wrong, fix it with update, passing title.",
  'prompt.later': '- Work for later, not this turn: add with item only (no subtasks), recorded as a planned item.',
  'prompt.change': '- When the plan changes, add new subtasks or remove the ones no longer needed.',
  'prompt.agent': '- After dispatching a subagent for a subtask, update it with agent (the agentId the Agent tool returned).',
  'prompt.subagent': '- When you are a subagent, only update the subtasks handed to you; do not add work items.',
  'prompt.single': '- A single question and answer needs no subtasks.',

  'tool.intro': 'Maintain this session\'s task board (the "Tasks" tab of the jarvis pane). Two levels: work items (ids like "2") → subtasks (ids like "2.3").',
  'tool.add':
    'op=add: item creates a new item, optionally with subtasks; or to=an existing item id adds subtasks to it; with neither item nor to, subtasks alone hang under the current request item. With item and subtasks, while the current request item has no subtasks yet, they merge into the current request item (its title becomes item). item alone makes a planned item.',
  'tool.update':
    'op=update: id names an item or subtask; pass status (pending/in_progress/completed), title, or agent (the agentId of the subagent handling this subtask). An item with subtasks takes its status from them; marking it completed marks all its subtasks completed.',
  'tool.remove': 'op=remove: delete the item or subtask that id names.',
  'tool.list': 'op=list: return the whole board.',
  'tool.reply': 'Every successful call returns the updated board.',
  'tool.item': 'add: title of the new work item',
  'tool.to': 'add: id of the existing item to add subtasks to',
  'tool.subtasks': 'add: subtask titles, in the order they will be done',
  'tool.id': 'update/remove: item id ("2") or subtask id ("2.3")',
  'tool.title': 'update: new title',
  'tool.agent': 'update: agentId of the subagent handling this subtask',

  'sum.system':
    'You write a one-line summary for a work board. Reply with only that one line, in English: no quotes, no trailing period, no prefix such as "Title:", no explanation, and no symbols like → × — – or curly quotes.',
  'sum.result':
    'In at most {max} characters, write the result or conclusion of this request, e.g. "42", "CAS-based atomic update", "merged into master".\n\nRequest:\n{prompt}{subtasks}\n\nAnswer:\n{answer}',
  'sum.subtasks': '\n\nSubtasks:\n{list}',
  'cls.system':
    'You sort requests for a work board. Reply in English with exactly the number of lines asked for: no quotes, no trailing period, no prefix such as "Title:", no explanation, and no symbols like → × — – or curly quotes.',
  'cls.noTopics': '(none yet)',
  'cls.topic': '{id} {title} (latest request: {latest})',
  'cls.last': 'Previous request: {title}{topic}\n\n',
  'cls.lastTopic': ' (topic {id})',
  'cls.title': 'In at most {max} characters, write what this request asks for, starting with a verb, e.g. "Compute 7*6", "Explain CAS", "Fix jarvis highlight".',
  'cls.which': 'Then decide which of the topics below it belongs to.',
  'cls.twoLines': 'Reply with only two lines:',
  'cls.line1': 'Line 1: the request title.',
  'cls.line2':
    'Line 2: if it belongs to an existing topic, the topic number (digits only); if none fits, "New " followed by a topic name of at most {max} characters, e.g. "New Check-in top-ups".',
  'cls.short': 'A very short request (e.g. "confirm", "ok", "1", "push") usually continues the previous request\'s topic.',
  'cls.topics': 'Existing topics (most recently active first):\n{topics}',
  'cls.request': '{last}Request:\n{prompt}',
}

export const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<MsgKey, string>>>> = { 'zh-TW': zhTW, en }

let current: Locale = 'zh-TW'
// what each module rebuilds when the locale changes: its constants made of the dictionary's words
const listeners: (() => void)[] = []

// The locale an environment value picks: `en` is English, anything else (or nothing) zh-TW.
export const localeOf = (value: string | undefined): Locale => (value === 'en' ? 'en' : 'zh-TW')

export const locale = (): Locale => current

export function setLocale(next: Locale): void {
  current = next
  for (const f of listeners) f()
}

// Runs `f` now and again on every locale change; a module keeps its localized constants with it.
export function localized(f: () => void): void {
  listeners.push(f)
  f()
}

// The locale from JARVIS_LANG; zh-TW when the environment cannot be read. The one place it is read.
export async function loadLocale($: Pick<EngineInterface, 'env'>): Promise<Locale> {
  let value: string | undefined
  try {
    value = await $.env.get('JARVIS_LANG')
  } catch {
    // no env: the default
  }
  setLocale(localeOf(value))
  return current
}

// A message in the current locale, each {name} filled from `vars` and each {name|one|other} the
// word for the count in `name` (one when it is 1), in one pass, so a value is never read for
// placeholders of its own; a name `vars` lacks stays as written.
export function t(key: MsgKey, vars?: Readonly<Record<string, string | number>>): string {
  const text = DICTIONARIES[current][key]
  if (vars === undefined) return text
  return text.replace(/\{(\w+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g, (whole, name: string, one?: string, other?: string) => {
    if (!Object.hasOwn(vars, name)) return whole
    const value = vars[name]
    if (one === undefined || other === undefined) return String(value)
    return Number(value) === 1 ? one : other
  })
}
