/** Locale resources owned by the default Pedagogy package, resolved by the Application. */
export const defaultTheoryMessages = {
  "default.node-progress.completion.complete": {
    en: "Completion from {playground}: complete; scope {scope}; report {report}; valid until {validUntil}",
    "zh-CN": "{playground} 完成状态：已完成；范围 {scope}；报告 {report}；有效期至 {validUntil}",
  },
  "default.node-progress.completion.incomplete": {
    en: "Completion from {playground}: incomplete; scope {scope}; report {report}; valid until {validUntil}",
    "zh-CN": "{playground} 完成状态：未完成；范围 {scope}；报告 {report}；有效期至 {validUntil}",
  },
  "default.node-progress.completion.expired": {
    en: "Completion from {playground}: expired; scope {scope}; report {report}; valid until {validUntil}",
    "zh-CN": "{playground} 完成状态：已过期；范围 {scope}；报告 {report}；有效期至 {validUntil}",
  },
  "default.node-progress.completion.absent": {
    en: "Completion from {playground}: absent; scope {scope}; report {report}; valid until {validUntil}",
    "zh-CN": "{playground} 完成状态：尚未报告；范围 {scope}；报告 {report}；有效期至 {validUntil}",
  },
  "default.node-progress.no-success": {
    en: "{demonstrated} of {window}, last success none; aided practice {aidedPractice}",
    "zh-CN": "{demonstrated}/{window}，尚无成功；辅助练习 {aidedPractice}",
  },
  "default.node-progress.last-success": {
    en: "{demonstrated} of {window}, last success {lastSuccess}; aided practice {aidedPractice}",
    "zh-CN": "{demonstrated}/{window}，最近成功：{lastSuccess}；辅助练习 {aidedPractice}",
  },
  "default.node-progress.no-success.remainder": {
    en: "last success none; aided practice {aidedPractice}",
    "zh-CN": "尚无成功；辅助练习 {aidedPractice}",
  },
  "default.node-progress.last-success.remainder": {
    en: "last success {lastSuccess}; aided practice {aidedPractice}",
    "zh-CN": "最近成功：{lastSuccess}；辅助练习 {aidedPractice}",
  },
  "default.charting.note.known": { en: "I already know this.", "zh-CN": "这个我已经会了。" },
  "default.charting.note.unwanted": { en: "I don't need this.", "zh-CN": "这个我不需要。" },
  "default.charting.note.why": { en: "Why is this needed?", "zh-CN": "为什么需要这个？" },
  "default.charting.note.merge": { en: "These are one thing for me.", "zh-CN": "对我来说这些是一回事。" },
} as const;
