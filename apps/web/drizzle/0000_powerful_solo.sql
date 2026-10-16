CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_account_user_id` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_account_provider_account` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `ai_task` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`media_type` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt` text NOT NULL,
	`options` text,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`task_id` text,
	`task_info` text,
	`task_result` text,
	`cost_credits` integer DEFAULT 0 NOT NULL,
	`scene` text DEFAULT '' NOT NULL,
	`credit_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ai_task_user_media_type` ON `ai_task` (`user_id`,`media_type`);--> statement-breakpoint
CREATE INDEX `idx_ai_task_media_type_status` ON `ai_task` (`media_type`,`status`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key` text,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_apikey_user_status` ON `apikey` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_apikey_keyhash_status` ON `apikey` (`key_hash`,`status`);--> statement-breakpoint
CREATE TABLE `arena_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`publication_id`) REFERENCES `arena_publications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `arena_comments_publication_created` ON `arena_comments` (`publication_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `arena_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`ciphertext` text NOT NULL,
	`masked` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `arena_credentials_owner` ON `arena_credentials` (`owner_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `arena_likes` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `arena_publications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_likes_publication_owner` ON `arena_likes` (`publication_id`,`owner_id`);--> statement-breakpoint
CREATE TABLE `arena_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`game_id` text NOT NULL,
	`status` text NOT NULL,
	`summary_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`result_json` text,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `arena_matches_owner_updated` ON `arena_matches` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `arena_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`endpoint` text NOT NULL,
	`credential_id` text NOT NULL,
	`think_mode` text DEFAULT 'never' NOT NULL,
	`think_budget` integer DEFAULT 1024 NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `arena_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `arena_profiles_owner` ON `arena_profiles` (`owner_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `arena_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`match_id` text NOT NULL,
	`game_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`replay_key` text NOT NULL,
	`replay_json` text,
	`summary_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`match_id`) REFERENCES `arena_matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_publications_match` ON `arena_publications` (`match_id`);--> statement-breakpoint
CREATE INDEX `arena_publications_status_created` ON `arena_publications` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `arena_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `arena_publications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_reports_publication_owner` ON `arena_reports` (`publication_id`,`owner_id`);--> statement-breakpoint
CREATE TABLE `chat` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`content` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_user_status` ON `chat` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `chat_message` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_message_chat_id` ON `chat_message` (`chat_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_chat_message_user_id` ON `chat_message` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `config` (
	`name` text NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `config_name_unique` ON `config` (`name`);--> statement-breakpoint
CREATE TABLE `credit` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`user_email` text,
	`order_no` text,
	`subscription_no` text,
	`transaction_no` text NOT NULL,
	`transaction_type` text NOT NULL,
	`transaction_scene` text,
	`credits` integer NOT NULL,
	`remaining_credits` integer DEFAULT 0 NOT NULL,
	`description` text,
	`expires_at` integer,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`consumed_detail` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_transaction_no_unique` ON `credit` (`transaction_no`);--> statement-breakpoint
CREATE INDEX `idx_credit_consume_fifo` ON `credit` (`user_id`,`status`,`transaction_type`,`remaining_credits`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_credit_order_no` ON `credit` (`order_no`);--> statement-breakpoint
CREATE INDEX `idx_credit_subscription_no` ON `credit` (`subscription_no`);--> statement-breakpoint
CREATE TABLE `idea` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`is_public` integer DEFAULT true NOT NULL,
	`vote_count` integer DEFAULT 0 NOT NULL,
	`admin_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_idea_status` ON `idea` (`status`);--> statement-breakpoint
CREATE INDEX `idx_idea_public_votes` ON `idea` (`is_public`,`vote_count`);--> statement-breakpoint
CREATE INDEX `idx_idea_public_created` ON `idea` (`is_public`,`created_at`);--> statement-breakpoint
CREATE TABLE `idea_vote` (
	`id` text PRIMARY KEY NOT NULL,
	`idea_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`idea_id`) REFERENCES `idea`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_idea_vote_idea_user` ON `idea_vote` (`idea_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_idea_vote_user` ON `idea_vote` (`user_id`);--> statement-breakpoint
CREATE TABLE `invite_code` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`trial_days` integer DEFAULT 15 NOT NULL,
	`note` text DEFAULT '',
	`created_by` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_code_code_unique` ON `invite_code` (`code`);--> statement-breakpoint
CREATE INDEX `idx_invite_code_code` ON `invite_code` (`code`);--> statement-breakpoint
CREATE TABLE `order` (
	`id` text PRIMARY KEY NOT NULL,
	`order_no` text NOT NULL,
	`user_id` text NOT NULL,
	`user_email` text,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`product_id` text,
	`payment_type` text,
	`payment_interval` text,
	`payment_provider` text NOT NULL,
	`payment_session_id` text,
	`checkout_info` text NOT NULL,
	`checkout_result` text,
	`payment_result` text,
	`discount_code` text,
	`discount_amount` integer,
	`discount_currency` text,
	`payment_email` text,
	`payment_amount` integer,
	`payment_currency` text,
	`paid_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`description` text,
	`product_name` text,
	`subscription_id` text,
	`subscription_result` text,
	`checkout_url` text,
	`callback_url` text,
	`credits_amount` integer,
	`credits_valid_days` integer,
	`plan_name` text,
	`payment_product_id` text,
	`invoice_id` text,
	`invoice_url` text,
	`subscription_no` text,
	`transaction_id` text,
	`payment_user_name` text,
	`payment_user_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_order_no_unique` ON `order` (`order_no`);--> statement-breakpoint
CREATE INDEX `idx_order_user_status_payment_type` ON `order` (`user_id`,`status`,`payment_type`);--> statement-breakpoint
CREATE INDEX `idx_order_transaction_provider` ON `order` (`transaction_id`,`payment_provider`);--> statement-breakpoint
CREATE INDEX `idx_order_created_at` ON `order` (`created_at`);--> statement-breakpoint
CREATE TABLE `permission` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`resource` text NOT NULL,
	`action` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permission_code_unique` ON `permission` (`code`);--> statement-breakpoint
CREATE INDEX `idx_permission_resource_action` ON `permission` (`resource`,`action`);--> statement-breakpoint
CREATE TABLE `post` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`title` text,
	`description` text,
	`image` text,
	`content` text,
	`categories` text,
	`tags` text,
	`author_name` text,
	`author_image` text,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_slug_unique` ON `post` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_post_type_status` ON `post` (`type`,`status`);--> statement-breakpoint
CREATE TABLE `role` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_name_unique` ON `role` (`name`);--> statement-breakpoint
CREATE INDEX `idx_role_status` ON `role` (`status`);--> statement-breakpoint
CREATE TABLE `role_permission` (
	`id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`permission_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `permission`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_role_permission_role_permission` ON `role_permission` (`role_id`,`permission_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `idx_session_user_expires` ON `session` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_no` text NOT NULL,
	`user_id` text NOT NULL,
	`user_email` text,
	`status` text NOT NULL,
	`payment_provider` text NOT NULL,
	`subscription_id` text NOT NULL,
	`subscription_result` text,
	`product_id` text,
	`description` text,
	`amount` integer,
	`currency` text,
	`interval` text,
	`interval_count` integer,
	`trial_period_days` integer,
	`current_period_start` integer,
	`current_period_end` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`plan_name` text,
	`billing_url` text,
	`product_name` text,
	`credits_amount` integer,
	`credits_valid_days` integer,
	`payment_product_id` text,
	`payment_user_id` text,
	`canceled_at` integer,
	`canceled_end_at` integer,
	`canceled_reason` text,
	`canceled_reason_type` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_subscription_no_unique` ON `subscription` (`subscription_no`);--> statement-breakpoint
CREATE INDEX `idx_subscription_user_status_interval` ON `subscription` (`user_id`,`status`,`interval`);--> statement-breakpoint
CREATE INDEX `idx_subscription_provider_id` ON `subscription` (`subscription_id`,`payment_provider`);--> statement-breakpoint
CREATE INDEX `idx_subscription_created_at` ON `subscription` (`created_at`);--> statement-breakpoint
CREATE TABLE `taxonomy` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`image` text,
	`icon` text,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_slug_unique` ON `taxonomy` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_taxonomy_type_status` ON `taxonomy` (`type`,`status`);--> statement-breakpoint
CREATE TABLE `ticket` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ticket_user` ON `ticket` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_ticket_status` ON `ticket` (`status`);--> statement-breakpoint
CREATE TABLE `ticket_message` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`content` text NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `ticket`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ticket_message_ticket` ON `ticket_message` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`utm_source` text DEFAULT '' NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`locale` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE INDEX `idx_user_name` ON `user` (`name`);--> statement-breakpoint
CREATE INDEX `idx_user_created_at` ON `user` (`created_at`);--> statement-breakpoint
CREATE TABLE `user_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`invite_code_id` text NOT NULL,
	`activated_at` integer NOT NULL,
	`trial_ends_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invite_code_id`) REFERENCES `invite_code`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_user_invite_user` ON `user_invite` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_user_invite_code` ON `user_invite` (`invite_code_id`);--> statement-breakpoint
CREATE TABLE `user_role` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_role_user_expires` ON `user_role` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_verification_identifier` ON `verification` (`identifier`);