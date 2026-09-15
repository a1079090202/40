-- 球馆预订计费系统 schema
-- 金额一律按「分」存整数；时段一律本地时间，半小时粒度，key 形如 'YYYY-MM-DD HH:MM'

CREATE TABLE IF NOT EXISTS courts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('badminton', 'basketball')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS coaches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  created_at TEXT NOT NULL
);

-- 会员卡：次卡按场地类型，储值卡按金额（分）
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('package', 'stored_value')),
  court_type TEXT CHECK (court_type IS NULL OR court_type IN ('badminton', 'basketball')),
  remaining_times INTEGER,          -- 次卡：总剩余次数（含冻结中）
  frozen_times INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER,            -- 储值卡：余额（含冻结中）
  frozen_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  CHECK (
    (kind = 'package' AND court_type IS NOT NULL AND remaining_times IS NOT NULL AND balance_cents IS NULL)
    OR (kind = 'stored_value' AND court_type IS NULL AND balance_cents IS NOT NULL AND remaining_times IS NULL)
  )
);

-- 冻结记录：下单建 held，取消释放/核销扣减/爽约扣没后结算
CREATE TABLE IF NOT EXISTS card_holds (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  resource TEXT NOT NULL CHECK (resource IN ('times', 'cash')),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'consumed', 'forfeited')),
  created_at TEXT NOT NULL,
  settled_at TEXT
);

-- 卡流水：冻结 / 释放 / 扣减全部留痕
CREATE TABLE IF NOT EXISTS card_txns (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  booking_id INTEGER REFERENCES bookings(id),
  type TEXT NOT NULL CHECK (type IN ('freeze', 'release', 'consume')),
  resource TEXT NOT NULL CHECK (resource IN ('times', 'cash')),
  category TEXT,                    -- 'court' | 'light' | 'forfeit'
  amount INTEGER NOT NULL,          -- 次数或分，正数
  balance_after INTEGER,            -- 储值卡扣减/释放后的可用余额（不含冻结）
  note TEXT,
  created_at TEXT NOT NULL
);

-- 班课（周期模板）
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  coach_id INTEGER NOT NULL REFERENCES coaches(id),
  court_id INTEGER NOT NULL REFERENCES courts(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=周日
  start_time TEXT NOT NULL,        -- 'HH:MM'
  end_time TEXT NOT NULL,
  start_date TEXT NOT NULL,        -- 'YYYY-MM-DD' 第一次课
  weeks INTEGER NOT NULL,
  holiday_policy TEXT NOT NULL CHECK (holiday_policy IN ('postpone', 'makeup')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 班课每一次实际/计划占场
CREATE TABLE IF NOT EXISTS course_sessions (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  seq INTEGER NOT NULL,            -- 第几节课 1..weeks
  court_id INTEGER NOT NULL REFERENCES courts(id),
  date TEXT NOT NULL,              -- 'YYYY-MM-DD'
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'leave', 'makeup')),
  orig_date TEXT,                  -- makeup：被节假日冲掉的原日期
  note TEXT,
  UNIQUE (course_id, seq, state)
);

-- 手动整段请假登记（按实际排课日期），重新展开时保留
CREATE TABLE IF NOT EXISTS course_leaves (
  course_id INTEGER NOT NULL REFERENCES courses(id),
  date TEXT NOT NULL,
  PRIMARY KEY (course_id, date)
);

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,           -- 'YYYY-MM-DD'
  name TEXT NOT NULL
);

-- 散客预订
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  card_id INTEGER NOT NULL REFERENCES cards(id),
  court_id INTEGER NOT NULL REFERENCES courts(id),
  start_slot TEXT NOT NULL,        -- 含
  end_slot TEXT NOT NULL,          -- 不含
  slot_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'checked_in', 'cancelled', 'late_cancelled', 'no_show')),
  court_fee_cents INTEGER NOT NULL DEFAULT 0,  -- 冻结的场租（储值卡）
  light_fee_cents INTEGER NOT NULL DEFAULT 0,  -- 冻结的灯光费（晚间场次预估）
  created_at TEXT NOT NULL,
  checked_in_at TEXT,
  cancelled_at TEXT,
  finalized_at TEXT
);

CREATE TABLE IF NOT EXISTS violations (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  type TEXT NOT NULL DEFAULT 'no_show',
  date TEXT NOT NULL,              -- 'YYYY-MM-DD' 爽约发生日
  created_at TEXT NOT NULL
);

-- 核销时确认的场馆收入（场租 / 灯光费）
CREATE TABLE IF NOT EXISTS revenue_entries (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  category TEXT NOT NULL CHECK (category IN ('court', 'light')),
  amount_cents INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('stored_card', 'cash')), -- 储值卡扣款 / 次卡现收灯光等
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_court_date ON course_sessions(court_id, date);
CREATE INDEX IF NOT EXISTS idx_bookings_court_start ON bookings(court_id, start_slot, end_slot);
CREATE INDEX IF NOT EXISTS idx_bookings_member ON bookings(member_id);
CREATE INDEX IF NOT EXISTS idx_txns_card ON card_txns(card_id);
CREATE INDEX IF NOT EXISTS idx_violations_member ON violations(member_id, date);
