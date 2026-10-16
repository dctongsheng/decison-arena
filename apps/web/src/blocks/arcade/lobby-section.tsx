import { ARCADE_GAME_IDS } from '@decision-arena/core';
import { ArrowRight, Gamepad2, Zap } from 'lucide-react';

import { Link } from '@/core/i18n/navigation';

import { ArcadeArtwork } from './canvas';
import { a } from './messages';

import './arcade.css';

export function ArcadeLobbySection() {
  return (
    <section className="arcade-lobby">
      <div className="arena-section-head">
        <div>
          <div className="arcade-eyebrow">
            <Zap size={14} />
            {a('eyebrow')}
          </div>
          <h2>{a('lobby_title')}</h2>
          <p>{a('lobby_description')}</p>
        </div>
        <Link className="arena-text-link" href="/arcade/new">
          {a('new_session')}
          <ArrowRight size={16} />
        </Link>
      </div>
      <div className="arcade-lobby-cards">
        {ARCADE_GAME_IDS.map((game, index) => (
          <Link
            key={game}
            href={`/arcade/new?game=${game}`}
            className="arcade-lobby-card"
          >
            <div className="arcade-lobby-art">
              <ArcadeArtwork gameId={game} />
              <span>0{index + 4}</span>
              <small>{a(`game.${game}.tag`)}</small>
            </div>
            <div className="arcade-lobby-copy">
              <h3>
                {a(`game.${game}`)}
                <ArrowRight size={18} />
              </h3>
              <p>{a(`game.${game}.description`)}</p>
              <span>
                <Gamepad2 size={14} />
                {a('continuous')} · {a('standard')}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
