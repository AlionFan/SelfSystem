export function migrateAccounts(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE COLLATE NOCASE,password_hash TEXT,verified_at TEXT,role TEXT NOT NULL DEFAULT 'user',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),device_id TEXT NOT NULL REFERENCES devices(id),expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invitations(code_hash TEXT PRIMARY KEY,email TEXT,owner_id TEXT,expires_at TEXT NOT NULL,used_at TEXT,created_by TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_codes(email TEXT NOT NULL,purpose TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(email,purpose));
    CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wechat_bindings(user_id TEXT PRIMARY KEY REFERENCES users(id),encrypted_token TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wechat_deliveries(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),entry_id TEXT,reminder_at TEXT,mode TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,short_code TEXT,callback_hash TEXT UNIQUE,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS wechat_scheduled_once ON wechat_deliveries(user_id,entry_id,reminder_at) WHERE mode='scheduled';
    CREATE INDEX IF NOT EXISTS session_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS wechat_pending ON wechat_deliveries(state,next_attempt);
    CREATE TABLE IF NOT EXISTS ai_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id),enabled INTEGER NOT NULL DEFAULT 0,wechat_auto INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),entry_id TEXT NOT NULL,base_version INTEGER NOT NULL,requested_kind TEXT NOT NULL,state TEXT NOT NULL,original_json TEXT NOT NULL,result_ids TEXT NOT NULL DEFAULT '[]',applied_versions TEXT NOT NULL DEFAULT '{}',advice TEXT NOT NULL DEFAULT '[]',error TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,entry_id,base_version));
    CREATE INDEX IF NOT EXISTS ai_job_user ON ai_jobs(user_id,created_at);
    CREATE INDEX IF NOT EXISTS ai_job_pending ON ai_jobs(state,created_at);
    CREATE TABLE IF NOT EXISTS ai_usage(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,user_id TEXT NOT NULL,day_key TEXT NOT NULL,month_key TEXT NOT NULL,cost_micros INTEGER NOT NULL,prompt_tokens INTEGER,completion_tokens INTEGER,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ai_usage_month ON ai_usage(month_key);
    CREATE TABLE IF NOT EXISTS voice_jobs(user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,transcript TEXT,error TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS voice_usage(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,day_key TEXT NOT NULL,month_key TEXT NOT NULL,seconds INTEGER NOT NULL,cost_micros INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS voice_usage_month ON voice_usage(month_key);
    CREATE INDEX IF NOT EXISTS voice_usage_day ON voice_usage(user_id,day_key);
    CREATE TABLE IF NOT EXISTS reminder_actions(delivery_id TEXT PRIMARY KEY REFERENCES wechat_deliveries(id),user_id TEXT NOT NULL,action TEXT NOT NULL,snooze_until TEXT,created_at TEXT NOT NULL);
  `);
  for(const table of ['entries','operations','devices']){
    if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='user_id'))db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT REFERENCES users(id)`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS entry_user ON entries(user_id); CREATE INDEX IF NOT EXISTS device_user ON devices(user_id)');
}
