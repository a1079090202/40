// 全馆业务配置。金额单位：分 / 每半小时。

export type CourtType = "badminton" | "basketball";

export const COURT_TYPE_LABEL: Record<CourtType, string> = {
  badminton: "羽毛球场",
  basketball: "篮球半场",
};

export const OPEN_FROM = "09:00"; // 每天开放起始
export const OPEN_TO = "22:00";   // 每天开放结束（最后一格 21:30 起）

/** 从该时刻起的格子收灯光费（晚场开灯） */
export const LIGHT_FROM = "18:00";

/** 场租：每个半小时，按场地类型（分） */
export const COURT_FEE_CENTS: Record<CourtType, number> = {
  badminton: 1500, // 15 元 / 半小时
  basketball: 3000, // 30 元 / 半小时
};

/** 灯光费：每个半小时，按场地类型（分） */
export const LIGHT_FEE_CENTS: Record<CourtType, number> = {
  badminton: 200, // 2 元
  basketball: 500, // 5 元
};

/** 开始前多少分钟内取消不退冻结 */
export const CANCEL_FREE_MINUTES = 120;

/** 开始后多少分钟未核销算爽约 */
export const NO_SHOW_GRACE_MINUTES = 30;

/** 自然月内爽约次数上限，达到限订 */
export const VIOLATION_LIMIT_PER_MONTH = 3;

/** 限订天数 */
export const BOOK_BAN_DAYS = 7;

/** 散客预订最早可提前天数 */
export const BOOK_AHEAD_DAYS = 14;

/** 一个预订最长格数（3 小时） */
export const MAX_SLOTS_PER_BOOKING = 6;
