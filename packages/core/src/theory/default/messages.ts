/** Locale resources owned by the default Pedagogy package, resolved by the Application. */
export const defaultTheoryMessages = {
  "default.state.done": { en: "Demonstrated", "zh-CN": "已掌握" },
  "default.state.tentative": { en: "Probably known", "zh-CN": "可能已掌握" },
  "default.state.open": { en: "Unknown", "zh-CN": "未知" },
  "default.checklist.done": { en: "Demonstrated", "zh-CN": "已展示掌握" },
  "default.checklist.tentative": { en: "Probably known · confirm with a check", "zh-CN": "可能已掌握 · 仍需检验确认" },
  "default.checklist.open": { en: "Not yet demonstrated", "zh-CN": "尚未展示掌握" },
  "default.node-progress.no-success": {
    en: "{counts}, last success none; aided practice {aidedPractice}",
    "zh-CN": "{counts}，尚无成功；辅助练习 {aidedPractice}",
  },
  "default.node-progress.last-success": {
    en: "{counts}, last success {lastSuccess}; aided practice {aidedPractice}",
    "zh-CN": "{counts}，最近成功：{lastSuccess}；辅助练习 {aidedPractice}",
  },
  "default.charting.note.known": { en: "I already know this.", "zh-CN": "这个我已经会了。" },
  "default.charting.note.unwanted": { en: "I don't need this.", "zh-CN": "这个我不需要。" },
  "default.charting.note.why": { en: "Why is this needed?", "zh-CN": "为什么需要这个？" },
  "default.charting.note.merge": { en: "These are one thing for me.", "zh-CN": "对我来说这些是一回事。" },
} as const;
