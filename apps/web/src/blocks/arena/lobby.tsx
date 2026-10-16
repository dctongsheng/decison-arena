import { useQuery } from '@tanstack/react-query';
import type { GameId } from '@decision-arena/core';
import {
  ArrowDown,
  ArrowRight,
  Bot,
  Braces,
  Check,
  CirclePlay,
  Compass,
  Flag,
  KeyRound,
  ShieldCheck,
  Sparkles,
  Swords,
  Users,
  Waves,
} from 'lucide-react';

import { Link } from '@/core/i18n/navigation';
import { apiGet } from '@/lib/api-client';
import { ArcadeLobbySection } from '@/blocks/arcade/lobby-section';
import { GameArtwork } from '@/components/arena/board';

import {
  ArenaShell,
  CommunityPost,
  formatDate,
  gameName,
  resultName,
  t,
} from './shared';

export function LobbyPage() {
  const community = useQuery({
    queryKey: ['arena-community', 'home'],
    queryFn: () =>
      apiGet<{ items: CommunityPost[] }>('/api/arena/community?limit=3'),
  });
  return (
    <ArenaShell>
      <section className="arena-hero">
        <div className="arena-hero-copy">
          <div className="arena-eyebrow">
            <span className="arena-live-dot" />
            {t('hero.eyebrow')}
          </div>
          <h1>
            {t('hero.title1')}
            <br />
            <span>{t('hero.title2')}</span>
          </h1>
          <p>{t('hero.description')}</p>
          <div className="arena-hero-actions">
            <Link className="arena-button" href="/new">
              {t('hero.start')}
              <ArrowRight size={18} />
            </Link>
            <Link className="arena-button secondary" href="/community">
              <CirclePlay size={18} />
              {t('hero.watch')}
            </Link>
          </div>
          <div className="arena-hero-proof">
            <span>
              <Check size={14} />
              {t('hero.byok')}
            </span>
            <span>
              <Check size={14} />
              {t('hero.open')}
            </span>
            <span>
              <Check size={14} />
              {t('hero.own')}
            </span>
          </div>
        </div>
        <div className="arena-hero-scene">
          <div className="arena-scene-label">
            <span className="arena-live-dot" />
            DECISION LAB<span>01 / ∞</span>
          </div>
          <GameArtwork gameId="gomoku" large />
          <div className="arena-scene-player p1">
            <span className="arena-scene-avatar">
              <Bot size={20} />
            </span>
            <div>
              <strong>Jev</strong>
              <small>DECISION MODEL</small>
            </div>
            <span className="arena-scene-chip">01</span>
          </div>
          <div className="arena-scene-player p2">
            <span className="arena-scene-avatar warm">
              <Waves size={20} />
            </span>
            <div>
              <strong>StartLux</strong>
              <small>DECISION MODEL</small>
            </div>
            <span className="arena-scene-chip">02</span>
          </div>
          <div className="arena-scene-caption">
            <Braces size={16} />
            {t('hero.visual')}
          </div>
        </div>
      </section>
      <div className="arena-section-head" id="games">
        <div>
          <div className="arena-eyebrow">THE PLAYGROUND</div>
          <h2>{t('lobby.games')}</h2>
        </div>
        <span className="arena-caption">
          {t('lobby.more')}
          <ArrowDown size={15} />
        </span>
      </div>
      <div className="arena-game-grid">
        {(['gomoku', 'xiangqi', 'army'] as GameId[]).map((gameId, i) => (
          <Link
            href={`/new?game=${gameId}`}
            className="arena-game-card"
            key={gameId}
          >
            <div className="arena-game-card-art">
              <GameArtwork gameId={gameId} />
              <span className="arena-game-number">0{i + 1}</span>
              <span className="arena-game-tag">{t(`game.${gameId}.tag`)}</span>
            </div>
            <div className="arena-game-card-body">
              <div>
                <h3>{gameName(gameId)}</h3>
                <span className="arena-card-arrow">
                  <ArrowRight size={20} />
                </span>
              </div>
              <p>{t(`game.${gameId}.description`)}</p>
              <div className="arena-game-meta">
                <span>{t(`game.${gameId}.meta`)}</span>
                <span>
                  <Users size={14} />
                  {t('lobby.three_modes')}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
      <ArcadeLobbySection />
      <section className="arena-how">
        <div>
          <div className="arena-eyebrow">YOUR KEY. YOUR MOVE.</div>
          <h2>{t('how.title')}</h2>
          <p>{t('how.description')}</p>
          <Link className="arena-text-link" href="/models">
            {t('how.setup')}
            <ArrowRight size={16} />
          </Link>
        </div>
        <div className="arena-how-steps">
          {[
            { Icon: KeyRound, key: 'connect' },
            { Icon: Swords, key: 'choose' },
            { Icon: Compass, key: 'discover' },
          ].map(({ Icon, key }, i) => (
            <div className="arena-how-step" key={key}>
              <span className="arena-icon-box">
                <Icon size={21} />
              </span>
              <div>
                <small>0{i + 1}</small>
                <h3>{t(`how.${key}.title`)}</h3>
                <p>{t(`how.${key}.description`)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <div className="arena-section-head">
        <div>
          <div className="arena-eyebrow">FROM THE COMMUNITY</div>
          <h2>{t('lobby.community')}</h2>
        </div>
        <Link className="arena-text-link" href="/community">
          {t('lobby.explore')}
          <ArrowRight size={16} />
        </Link>
      </div>
      {community.data?.items.length ? (
        <div className="arena-post-grid">
          {community.data.items.slice(0, 3).map((post) => (
            <Link
              className="arena-mini-post arena-panel"
              href={`/community/${post.id}`}
              key={post.id}
            >
              <span className="arena-tag">{gameName(post.gameId)}</span>
              <h3>{post.title}</h3>
              <p>{post.description}</p>
              <div>
                <strong>{resultName(post.result, post.gameId)}</strong>
                <span>{formatDate(post.createdAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="arena-community-invite">
          <span className="arena-icon-box">
            <Flag size={26} />
          </span>
          <div>
            <h3>{t('lobby.community_empty')}</h3>
            <p>{t('lobby.community_empty_description')}</p>
          </div>
          <Link href="/new" className="arena-button secondary">
            {t('lobby.first_match')}
            <ArrowRight size={17} />
          </Link>
        </div>
      )}
      <section className="arena-values">
        <span>
          <ShieldCheck size={19} />
          {t('values.private')}
        </span>
        <span>
          <Braces size={19} />
          {t('values.extensible')}
        </span>
        <span>
          <Sparkles size={19} />
          {t('values.transparent')}
        </span>
      </section>
    </ArenaShell>
  );
}
