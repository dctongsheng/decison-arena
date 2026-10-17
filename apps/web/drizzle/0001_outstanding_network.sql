CREATE TABLE `arena_bamboo_connections` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`status` text DEFAULT 'not_connected' NOT NULL,
	`expires_at` integer,
	`models_json` text DEFAULT '[]' NOT NULL,
	`oauth_fingerprint` text DEFAULT '' NOT NULL,
	`lock_id` text,
	`lock_expires_at` integer,
	`phase` text,
	`last_error` text,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
