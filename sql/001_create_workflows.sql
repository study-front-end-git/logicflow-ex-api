CREATE TABLE IF NOT EXISTS workflows (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workflow_key VARCHAR(64) NOT NULL COMMENT 'Frontend workflow identifier',
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  graph_data JSON NOT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0 draft, 1 published, 2 disabled',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  published_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_workflow_key (workflow_key),
  KEY idx_status (status),
  KEY idx_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS workflow_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workflow_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  graph_data JSON NOT NULL,
  change_note VARCHAR(500) DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_workflow_version (workflow_id, version),
  CONSTRAINT fk_version_workflow
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
