/**
 * The hamoud economy.
 *
 * Hamoud are the game's coins. They have no cash value, cannot be bought,
 * sold or withdrawn, and exist only as a number in this ledger. Everything
 * below is game balance, not money.
 *
 * THE BALANCE PROBLEM
 *
 * Every player who logs in is handed DAILY_REWARD hamoud out of nothing (the
 * "faucet"). If nothing takes hamoud back out, the supply grows forever and
 * the number stops meaning anything. The only sink is the house edge on
 * trades, so for the supply to stay flat:
 *
 *     hamoud issued today  =  house take today
 *     dailyReward × players  =  edge × turnover
 *
 * which rearranges to the one rule that matters:
 *
 *     edge = dailyReward / turnoverPerPlayerPerDay
 *
 * The 100,000/day figure is NOT a free parameter — it is `1000 × 100 players`.
 * Aiming at a fixed 100,000 would deflate the economy at 50 players and
 * inflate it at 200, so the controller instead targets *exactly what the
 * faucet issued today*. At 100 daily players that is 100,000, and it stays
 * balanced at any player count. DAILY_HOUSE_TARGET below is the reference
 * figure for that 100-player day, used for display and for the tests.
 *
 * WHY THE PAYOUT IS 45% AND NOT 92%
 *
 * House edge on a binary trade = 1 − (1 + payoutRate) × winRate.
 *
 *   - At a 92% payout the house only has an edge below a 52.1% win rate, and
 *     a 4% edge needs 25,000 turnover per player per day — 250 trades of 100
 *     hamoud each, every day, from every player. Nobody plays that much.
 *   - Worse, `npm run strategies` shows a one-line "follow the last tick" bot
 *     wins 55–57% on the honest chart (momentum makes consecutive ticks lean
 *     the same way). At a 92% payout that bot PROFITS, and the economy leaks
 *     to anyone who automates it.
 *
 * At a 45% payout the break-even win rate is 69%, so even that 57% bot still
 * loses, and a 20% edge only needs ~5,000 turnover per player per day (50
 * trades of 100). Players also WIN MORE OFTEN — about 55% of trades instead
 * of 42% — which feels much better than a big-but-rare payout. Low payout,
 * high win rate is the combination that is both kinder and exploit-proof.
 *
 * WHAT THE CONTROLLER DOES
 *
 * `winRateFor` picks each new trade's planned result so the day lands on
 * target. It compares the house take so far with what the faucet has issued,
 * spreads the difference over the turnover it still expects today, and
 * converts that into a win rate. If the house falls behind, players win a bit
 * less; if it runs ahead, they win a bit more — it hands the surplus back
 * rather than grinding everyone down. The win rate is clamped to a band so no
 * player ever faces a hopeless or a guaranteed streak.
 */

/** Hamoud handed to each player once per game day. */
export const DAILY_REWARD = 1000;

/**
 * Reference daily house take: DAILY_REWARD × 100 players. The live target is
 * whatever the faucet actually issued today, so this is the 100-player case.
 */
export const DAILY_HOUSE_TARGET = 100_000;

/**
 * How the daily reward is paid.
 *
 *   "topUp"  — bring the balance UP TO dailyReward. A player sitting on 3,000
 *              gets nothing; one at zero gets the full 1,000. This is what
 *              keeps the economy closed: players who stop while they are
 *              ahead stop drawing from the faucet, so the faucet shrinks to
 *              match whatever the house manages to take back, automatically.
 *   "grant"  — hand over dailyReward no matter what. Simpler to explain, but
 *              players who bank a balance and stop playing inflate the supply
 *              forever and no house edge can catch them.
 */
export type RewardMode = "topUp" | "grant";

export interface EconomyConfig {
  /** Hamoud per player per game day — a top-up to this balance, or a flat grant. */
  readonly dailyReward: number;
  readonly rewardMode: RewardMode;
  /** A winning trade returns stake × (1 + payoutRate). */
  readonly payoutRate: number;
  /**
   * Starting guess for how much one active player stakes in a day. The
   * controller measures the real figure and replaces this after day one, so
   * it only matters on the very first day.
   */
  readonly expectedTurnoverPerPlayer: number;
  /**
   * How much of each day's faucet to take back. 1 = the supply stays exactly
   * flat, which also means the AVERAGE PLAYER ENDS EVERY DAY WITH NOTHING —
   * they lose the reward they were given. Below 1 the supply grows and
   * players can build a balance over time; 0.9 leaves them a tenth of the
   * reward to keep. Above 1 the supply shrinks.
   */
  readonly drainTarget: number;
  /**
   * The win rate the game aims to give players when the books are balanced.
   *
   * This is a free choice, which is the surprising part. A player who keeps
   * trading until their balance is gone hands the house their whole daily
   * reward whatever the edge is — the edge only decides HOW LONG that takes.
   * At a 45% payout, a 55% win rate is a 20% edge, so 1,000 hamoud lasts
   * about 5,000 of turnover (50 trades of 100). Drop the win rate to 42% and
   * the house collects the same amount in half the trades, which is simply a
   * worse game. So: anchor here, and correct only for drift.
   */
  readonly targetWinRate: number;
  /**
   * Share of the running imbalance to correct for, and the most the win rate
   * may be bent away from `targetWinRate` to do it.
   */
  readonly catchUpRate: number;
  readonly maxEdgeAdjust: number;
  /** Win-rate band. Keeps any single session from feeling fixed either way. */
  readonly minWinRate: number;
  readonly maxWinRate: number;
  /** Below this balance a player's win rate is nudged up by `lowBalanceBoost`. */
  readonly lowBalance: number;
  readonly lowBalanceBoost: number;
  /** Stake sizes the game offers. */
  readonly stakes: readonly number[];
}

export const DEFAULT_ECONOMY: EconomyConfig = {
  dailyReward: DAILY_REWARD,
  rewardMode: "topUp",
  payoutRate: 0.45,
  expectedTurnoverPerPlayer: 3000,
  drainTarget: 1,
  targetWinRate: 0.55,
  catchUpRate: 0.34,
  maxEdgeAdjust: 0.12,
  minWinRate: 0.4,
  maxWinRate: 0.68,
  lowBalance: 200,
  lowBalanceBoost: 0.06,
  stakes: [10, 50, 100, 500],
};

/** The win rate at which the house makes nothing. Above it, players profit. */
export function breakEvenWinRate(config: EconomyConfig): number {
  return 1 / (1 + config.payoutRate);
}

export type Outcome = "WIN" | "LOSS" | "TIE";

export interface PlayerAccount {
  readonly id: string;
  balance: number;
  /** Game day index of the last claim, so the reward can't be taken twice. */
  lastRewardDay: number;
  stakedToday: number;
  /** Payouts received minus stakes placed today. */
  netToday: number;
  tradesToday: number;
  winsToday: number;
}

/** A snapshot of the day's economy, for the UI and the simulation. */
export interface EconomyStats {
  readonly day: number;
  readonly players: number;
  /** Hamoud created by the faucet today — the number the house aims to take back. */
  readonly issuedToday: number;
  readonly stakedToday: number;
  readonly paidOutToday: number;
  /** stakedToday − paidOutToday. */
  readonly houseNetToday: number;
  /** houseNetToday / issuedToday, 1 = perfectly balanced. */
  readonly drainRatio: number;
  readonly tradesToday: number;
  readonly decidedToday: number;
  readonly winsToday: number;
  /** Share of decided trades won today. */
  readonly realisedWinRate: number;
  /**
   * The win rate the controller will plan the next trade with, before the
   * nudge a nearly-broke player gets.
   */
  readonly nextWinRate: number;
  /** Total hamoud held by all players. */
  readonly supply: number;
}

/** UTC day index. The demo drives this from the GAME clock so Skip ahead rolls days. */
export const dayOf = (nowSec: number): number => Math.floor(nowSec / 86400);

export class Economy {
  private readonly players = new Map<string, PlayerAccount>();
  private readonly activeToday = new Set<string>();
  private day: number;
  private issuedToday = 0;
  private stakedToday = 0;
  private paidOutToday = 0;
  private tradesToday = 0;
  private decidedToday = 0;
  private winsToday = 0;
  /** Running totals since the ledger was created. */
  private issuedTotal = 0;
  private houseTotal = 0;
  /** Measured turnover per active player, learned from the days that have run. */
  private turnoverEstimate: number;
  /** Drain still owed from earlier days. Positive = the house is behind. */
  private carry = 0;

  constructor(
    nowSec: number,
    readonly config: EconomyConfig = DEFAULT_ECONOMY,
  ) {
    this.day = dayOf(nowSec);
    this.turnoverEstimate = config.expectedTurnoverPerPlayer;
  }

  /** Roll the daily counters when the game clock crosses into a new day. */
  tick(nowSec: number): boolean {
    const today = dayOf(nowSec);
    if (today === this.day) return false;
    this.day = today;
    // Bank the finished day, learn from it, and carry forward whatever drain
    // it failed to collect so the supply stays flat in the long run.
    this.houseTotal += this.houseNetToday;
    this.carry += this.issuedToday * this.config.drainTarget - this.houseNetToday;
    if (this.activeToday.size > 0 && this.stakedToday > 0) {
      const perPlayer = this.stakedToday / this.activeToday.size;
      this.turnoverEstimate = 0.5 * this.turnoverEstimate + 0.5 * perPlayer;
    }
    this.issuedToday = 0;
    this.stakedToday = 0;
    this.paidOutToday = 0;
    this.tradesToday = 0;
    this.decidedToday = 0;
    this.winsToday = 0;
    this.activeToday.clear();
    for (const p of this.players.values()) {
      p.stakedToday = 0;
      p.netToday = 0;
      p.tradesToday = 0;
      p.winsToday = 0;
    }
    return true;
  }

  account(id: string): PlayerAccount {
    let player = this.players.get(id);
    if (!player) {
      player = {
        id,
        balance: 0,
        lastRewardDay: -1,
        stakedToday: 0,
        netToday: 0,
        tradesToday: 0,
        winsToday: 0,
      };
      this.players.set(id, player);
    }
    return player;
  }

  /** True when this player has not taken today's reward yet. */
  canClaim(id: string): boolean {
    return this.account(id).lastRewardDay !== this.day;
  }

  /**
   * Hand over the daily reward. Returns what was added — 0 if it was already
   * taken today, or if the player is already above the top-up line.
   */
  claimDailyReward(id: string): number {
    const player = this.account(id);
    if (player.lastRewardDay === this.day) return 0;
    player.lastRewardDay = this.day;
    this.activeToday.add(id);
    const amount =
      this.config.rewardMode === "topUp"
        ? Math.max(0, this.config.dailyReward - player.balance)
        : this.config.dailyReward;
    player.balance += amount;
    this.issuedToday += amount;
    this.issuedTotal += amount;
    return amount;
  }

  /** Seconds until the next game day, when the reward comes round again. */
  secondsToNextReward(nowSec: number): number {
    return (this.day + 1) * 86400 - nowSec;
  }

  /**
   * The win rate to plan this player's next trade with. Reads the day's
   * ledger, not the player's luck, so it steers the economy rather than
   * punishing anyone in particular — apart from the low-balance nudge, which
   * keeps a nearly-broke player in the game.
   */
  winRateFor(id: string): number {
    // `get`, not `account`: asking about a player must not create one.
    const balance = this.players.get(id)?.balance ?? Infinity;
    const boost = balance < this.config.lowBalance ? this.config.lowBalanceBoost : 0;
    return Math.min(this.config.maxWinRate, this.baseWinRate() + boost);
  }

  /** The controller's rate before any per-player nudge — what the economy is doing. */
  baseWinRate(): number {
    const { payoutRate, targetWinRate, catchUpRate, maxEdgeAdjust, minWinRate, maxWinRate } =
      this.config;
    // Start from the edge that gives players the win rate the game aims for.
    const nominalEdge = 1 - (1 + payoutRate) * targetWinRate;
    // Correct for drift: everything the faucet has issued and the house has
    // not taken back yet, today's running total included. Spread over a day's
    // expected turnover, damped, and bounded so the odds never lurch.
    const behind = this.carry + (this.issuedToday * this.config.drainTarget - this.houseNetToday);
    const expected = Math.max(1, this.activeToday.size) * this.turnoverEstimate;
    const adjust = Math.max(
      -maxEdgeAdjust,
      Math.min(maxEdgeAdjust, (behind * catchUpRate) / expected),
    );
    const winRate = (1 - (nominalEdge + adjust)) / (1 + payoutRate);
    return Math.min(maxWinRate, Math.max(minWinRate, winRate));
  }

  /** Take the stake. Returns false when the player cannot cover it. */
  placeStake(id: string, stake: number): boolean {
    const player = this.account(id);
    if (!(stake > 0) || player.balance < stake) return false;
    player.balance -= stake;
    player.stakedToday += stake;
    player.netToday -= stake;
    player.tradesToday++;
    this.stakedToday += stake;
    this.tradesToday++;
    this.activeToday.add(id);
    return true;
  }

  /**
   * Pay a finished trade. WIN returns stake × (1 + payoutRate), TIE refunds
   * the stake (the price landed exactly on entry — common on markets with a
   * coarse tick), LOSS returns nothing. Returns what was credited.
   */
  settle(id: string, stake: number, outcome: Outcome): number {
    const player = this.account(id);
    const credit =
      outcome === "WIN" ? stake * (1 + this.config.payoutRate) : outcome === "TIE" ? stake : 0;
    player.balance += credit;
    player.netToday += credit;
    this.paidOutToday += credit;
    if (outcome !== "TIE") {
      this.decidedToday++;
      if (outcome === "WIN") {
        player.winsToday++;
        this.winsToday++;
      }
    }
    return credit;
  }

  get houseNetToday(): number {
    return this.stakedToday - this.paidOutToday;
  }

  /** Hamoud in player hands. Rises with rewards, falls with the house edge. */
  get supply(): number {
    let total = 0;
    for (const p of this.players.values()) total += p.balance;
    return total;
  }

  /** Issued and taken since the ledger started — the long-run balance check. */
  get totals(): { issued: number; houseTake: number } {
    return { issued: this.issuedTotal, houseTake: this.houseTotal + this.houseNetToday };
  }

  /** Turnover per active player the controller is pacing against. */
  get pacing(): { turnoverPerPlayer: number; carry: number } {
    return { turnoverPerPlayer: this.turnoverEstimate, carry: this.carry };
  }

  stats(): EconomyStats {
    return {
      day: this.day,
      players: this.activeToday.size,
      issuedToday: this.issuedToday,
      stakedToday: this.stakedToday,
      paidOutToday: this.paidOutToday,
      houseNetToday: this.houseNetToday,
      drainRatio: this.issuedToday > 0 ? this.houseNetToday / this.issuedToday : 0,
      tradesToday: this.tradesToday,
      decidedToday: this.decidedToday,
      winsToday: this.winsToday,
      realisedWinRate: this.decidedToday > 0 ? this.winsToday / this.decidedToday : 0,
      nextWinRate: this.baseWinRate(),
      supply: this.supply,
    };
  }
}
