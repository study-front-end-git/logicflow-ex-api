CREATE TABLE IF NOT EXISTS workflow_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_key CHAR(36) NOT NULL,
  workflow_id BIGINT UNSIGNED NOT NULL,
  workflow_version INT UNSIGNED NOT NULL,
  run_mode VARCHAR(20) NOT NULL DEFAULT 'debug',
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  inputs JSON NOT NULL,
  output JSON DEFAULT NULL,
  trace JSON DEFAULT NULL,
  error_code VARCHAR(100) DEFAULT NULL,
  error_message VARCHAR(1000) DEFAULT NULL,
  duration_ms INT UNSIGNED DEFAULT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_workflow_run_key (run_key),
  KEY idx_workflow_runs (workflow_id, started_at),
  KEY idx_run_status (status),
  CONSTRAINT fk_run_workflow
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
