CREATE TABLE IF NOT EXISTS http_node_test_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  test_run_key CHAR(36) NOT NULL,
  workflow_id BIGINT UNSIGNED NOT NULL,
  node_key VARCHAR(255) NOT NULL,
  variables JSON NOT NULL,
  request_data JSON NOT NULL,
  response_data JSON NOT NULL,
  output_data JSON NOT NULL,
  output_options JSON NOT NULL,
  duration_ms INT UNSIGNED DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_http_node_test_run_key (test_run_key),
  KEY idx_http_node_latest_run (workflow_id, node_key, created_at),
  CONSTRAINT fk_http_node_test_run_workflow
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
