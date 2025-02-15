import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BotService } from '../bot/bot.service';
import SteamTradeOfferManager from 'steam-tradeoffer-manager';
import {
  CreateTradeResponse,
  GetTradesResponse,
  Item,
  TradeOffer,
  TradeOfferExchangeDetails,
  TRADE_CHANGED_EVENT,
  TRADE_RECEIVED_EVENT,
  TRADE_SENT_EVENT,
  TRADE_CONFIRMATION_NEEDED_EVENT,
} from '@tf2-automatic/bot-data';
import { SteamException } from '../common/exceptions/eresult.exception';
import { Config, SteamAccountConfig } from '../common/config/configuration';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common/services';
import { EventsService } from '../events/events.service';
import fastq from 'fastq';
import type { queueAsPromised } from 'fastq';
import SteamUser from 'steam-user';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Gauge } from 'prom-client';
import sizeof from 'object-sizeof';
import {
  CounterTradeDto,
  CreateTradeDto,
  GetTradesDto,
} from '@tf2-automatic/dto';
import Bottleneck from 'bottleneck';

interface TradeOfferData {
  published?: SteamUser.ETradeOfferState;
  conf?: number;
  accept?: number;
}

@Injectable()
export class TradesService {
  private readonly logger: Logger = new Logger(TradesService.name);

  private readonly manager = this.botService.getManager();
  private readonly community = this.botService.getCommunity();

  private readonly ensurePolldataPublishedQueue: queueAsPromised<string> =
    fastq.promise(this.ensurePolldataPublished.bind(this), 1);

  private readonly ensureOfferPublishedQueue: queueAsPromised<SteamTradeOfferManager.TradeOffer> =
    fastq.promise(this.ensureOfferPublished.bind(this), 1);

  private ensurePollDataTimeout: NodeJS.Timeout;
  private ensureOfferPublishedLimiter = new Bottleneck({
    minTime: 1000,
  });

  constructor(
    private readonly botService: BotService,
    private readonly configService: ConfigService<Config>,
    private readonly eventsService: EventsService,
    @InjectMetric('bot_offers_sent_total')
    private readonly sentCounter: Counter,
    @InjectMetric('bot_offers_received_total')
    private readonly receivedCounter: Counter,
    @InjectMetric('bot_polldata_size_bytes')
    private readonly pollDataSize: Gauge,
    @InjectMetric('bot_asset_cache_size_bytes')
    private readonly assetCacheSize: Gauge,
    @InjectMetric('bot_offers_active')
    private readonly activeOffers: Gauge,
  ) {
    this.manager.on('newOffer', (offer) => {
      this.handleNewOffer(offer);
    });

    this.manager.on('sentOfferChanged', (offer, oldState) => {
      this.handleOfferChanged(offer, oldState);
    });

    this.manager.on('receivedOfferChanged', (offer, oldState) => {
      this.handleOfferChanged(offer, oldState);
    });

    this.manager.on('pollData', () => {
      this.ensurePollData();
    });

    this.manager.once('pollSuccess', () => {
      this.ensurePollData();
    });

    // Capture offers from getOffers function to detect relevant changes
    const origGetOffers = this.manager.getOffers.bind(this.manager);
    this.manager.getOffers = (...args) => {
      const callback = args.pop();
      origGetOffers(...args, (err, sent, received) => {
        if (err) {
          return callback(err);
        }

        callback(err, sent, received);

        try {
          this.handleOffers(sent, received);
        } catch (err) {
          // Catch the error because we don't want trade offer manager to think an error occurred
          this.logger.warn('Error while handling offers: ' + err.message);
        }
      });
    };
  }

  private handleOffers(
    sent: SteamTradeOfferManager.TradeOffer[],
    received: SteamTradeOfferManager.TradeOffer[],
  ) {
    sent.concat(received).forEach((offer) =>
      this.ensureOfferPublishedQueue.push(offer).catch(() => {
        // Ignore error
      }),
    );
  }

  private ensurePollData(): void {
    clearTimeout(this.ensurePollDataTimeout);

    this.ensurePollDataTimeout = setTimeout(() => {
      // Set polldata size inside timeout to minimize amount of times it is calculated
      this.pollDataSize.set(sizeof(this.manager.pollData));
      this.assetCacheSize.set(sizeof(this.manager._assetCache._entries));

      const { sent, received } = this.getActiveOfferCounts();

      this.activeOffers.set({ type: 'sent' }, sent);
      this.activeOffers.set({ type: 'received' }, received);
      this.activeOffers.set({ type: 'total' }, sent + received);

      this.logger.debug('Enqueuing offers to ensure poll data is published');
      Object.keys(this.manager.pollData.sent)
        .concat(Object.keys(this.manager.pollData.received))
        .forEach((id) => {
          this.ensurePolldataPublishedQueue.push(id).catch((err) => {
            // Ignore the error
            this.logger.warn('Error ensuring offer published: ' + err.message);
            console.log(err);
          });
        });
    }, 10000);
  }

  private getActiveOfferCounts(): { sent: number; received: number } {
    let sent = 0,
      received = 0;

    Object.keys(this.manager.pollData.sent).forEach((id) => {
      const state = this.manager.pollData.sent[id];

      if (state === SteamUser.ETradeOfferState.Active) {
        sent++;
      }
    });

    Object.keys(this.manager.pollData.received).forEach((id) => {
      const state = this.manager.pollData.received[id];

      if (state === SteamUser.ETradeOfferState.Active) {
        received++;
      }
    });

    return {
      sent,
      received,
    };
  }

  private async ensurePolldataPublished(id: string): Promise<void> {
    // Check if offer was already published
    const currentState =
      this.manager.pollData.sent[id] ??
      this.manager.pollData.received[id] ??
      null;

    if (currentState !== null) {
      const pollDataOfferData = this.manager.pollData.offerData ?? {};

      const offerData: TradeOfferData | null = pollDataOfferData[id] ?? null;
      const publishedState = offerData?.published ?? null;

      if (currentState === publishedState) {
        // Offer was already published
        return;
      }
    }

    // Get the actual offer
    const offer = await this.ensureOfferPublishedLimiter.schedule(() =>
      this._getTrade(id),
    );

    return this.ensureOfferPublishedQueue.push(offer);
  }

  private ensureOfferPublished(offer): Promise<void> {
    return this.ensureOfferStatePublished(offer).then(() => {
      return this.ensureConfirmationPublished(offer);
    });
  }

  private ensureOfferStatePublished(
    offer: SteamTradeOfferManager.TradeOffer,
  ): Promise<void> {
    const publishedState = offer.data('published') as
      | TradeOfferData['published']
      | null;

    if (offer.state === publishedState) {
      // This check is redundant but it's here just in case
      return Promise.resolve();
    }

    return this.publishOffer(offer, publishedState);
  }

  private ensureConfirmationPublished(
    offer: SteamTradeOfferManager.TradeOffer,
  ): Promise<void> {
    if (
      offer.confirmationMethod ==
        SteamTradeOfferManager.EConfirmationMethod.None ||
      offer.data('conf') === offer.data('accept')
    ) {
      // Offer is not waiting to be confirmed or confirmation was already published
      return Promise.resolve();
    } else if (
      offer.state !== SteamTradeOfferManager.ETradeOfferState.Active &&
      offer.state !==
        SteamTradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation
    ) {
      // Offer is not active or created needs confirmation
      return Promise.resolve();
    }

    // Publish confirmation
    return this.eventsService
      .publish(TRADE_CONFIRMATION_NEEDED_EVENT, {
        offer: this.mapOffer(offer),
      })
      .then(() => {
        // Update offer data to prevent publishing confirmation multiple times
        offer.data('conf', offer.data('accept'));
      })
      .catch(() => {
        // Ignore error
      });
  }

  private handleNewOffer(offer: SteamTradeOfferManager.TradeOffer) {
    this.logger.log(
      `Received offer #${offer.id} from ${offer.partner.getSteamID64()}`,
    );
    this.receivedCounter.inc();
  }

  private handleOfferChanged(
    offer: SteamTradeOfferManager.TradeOffer,
    oldState: SteamUser.ETradeOfferState,
  ): void {
    this.logger.log(
      `Offer #${offer.id} state changed: ${
        SteamTradeOfferManager.ETradeOfferState[oldState]
      } -> ${SteamTradeOfferManager.ETradeOfferState[offer.state]}`,
    );
  }

  private publishOffer(
    offer: SteamTradeOfferManager.TradeOffer,
    oldState: SteamUser.ETradeOfferState | null = null,
  ): Promise<void> {
    const publish = (): Promise<void> => {
      if (oldState) {
        return this.eventsService.publish(TRADE_CHANGED_EVENT, {
          offer: this.mapOffer(offer),
          oldState,
        });
      }

      if (!offer.isOurOffer) {
        // Offer was sent to us and there is no old state
        if (offer.state === SteamTradeOfferManager.ETradeOfferState.Active) {
          // Offer is active, means we received it
          return this.eventsService.publish(TRADE_RECEIVED_EVENT, {
            offer: this.mapOffer(offer),
          });
        }

        // Offer is not active, means the state changed, but we don't know what it changed from
        return this.eventsService.publish(TRADE_CHANGED_EVENT, {
          offer: this.mapOffer(offer),
          oldState: null,
        });
      }

      // Offer is ours and there is no old state

      if (
        offer.state ===
        SteamTradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation
      ) {
        // Offer is waiting for confirmation, means we sent it
        return this.eventsService.publish(TRADE_SENT_EVENT, {
          offer: this.mapOffer(offer),
        });
      }

      if (offer.state === SteamTradeOfferManager.ETradeOfferState.Active) {
        // Offer is active, means it is either sent now or changed
        if (offer.itemsToGive.length === 0) {
          // Offer is active and we are giving nothing, means we sent it without confirmation
          return this.eventsService.publish(TRADE_SENT_EVENT, {
            offer: this.mapOffer(offer),
          });
        }
      }

      // Offer is not active, or created and needs confirmation.

      return this.eventsService.publish(TRADE_CHANGED_EVENT, {
        offer: this.mapOffer(offer),
        oldState: null,
      });
    };

    // Wait for the event to be published
    return publish()
      .then(() => {
        offer.data('published', offer.state);
      })
      .catch((err) => {
        this.logger.warn('Error publishing offer: ' + err.message);
      });
  }

  getTrades(dto: GetTradesDto): Promise<GetTradesResponse> {
    return new Promise<GetTradesResponse>((resolve, reject) => {
      this.manager.getOffers(
        dto.filter,
        (
          err: Error,
          sent: SteamTradeOfferManager.TradeOffer[],
          received: SteamTradeOfferManager.TradeOffer[],
        ) => {
          if (err) {
            return reject(err);
          }

          const sentMapped = sent.map((offer) => {
            return this.mapOffer(offer);
          });
          const receivedMapped = received.map((offer) => {
            return this.mapOffer(offer);
          });

          return resolve({ sent: sentMapped, received: receivedMapped });
        },
      );
    }).catch((err) => {
      this.logger.error(
        `Error getting trades: ${err.message}${
          err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
        }`,
      );
      throw err;
    });
  }

  private _getTrade(id: string): Promise<SteamTradeOfferManager.TradeOffer> {
    return new Promise<TradeOffer>((resolve, reject) => {
      this.manager.getOffer(id, (err, offer) => {
        if (err) {
          if (err.message === 'NoMatch') {
            return reject(new BadRequestException('Trade offer not found'));
          }

          return reject(err);
        }

        return resolve(offer);
      });
    });
  }

  async getTrade(id: string): Promise<TradeOffer> {
    const offer = await this._getTrade(id).catch((err) => {
      this.logger.error(
        `Error getting trade offer: ${err.message}${
          err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
        }`,
      );
      throw err;
    });

    return this.mapOffer(offer);
  }

  createTrade(dto: CreateTradeDto): Promise<CreateTradeResponse> {
    const offer = this.manager.createOffer(dto.partner);

    if (dto.token) {
      offer.setToken(dto.token);
    }

    if (dto.message) {
      offer.setMessage(dto.message);
    }

    offer.addMyItems(dto.itemsToGive);
    offer.addTheirItems(dto.itemsToReceive);

    return this.sendOffer(offer);
  }

  async counterTrade(id: string, dto: CounterTradeDto): Promise<TradeOffer> {
    const offer = await this._getTrade(id);
    const counter = offer.counter();

    if (dto.message) {
      counter.setMessage(dto.message);
    }

    counter.itemsToGive = [];
    counter.itemsToReceive = [];

    counter.addMyItems(dto.itemsToGive);
    counter.addTheirItems(dto.itemsToReceive);

    return this.sendOffer(counter);
  }

  private sendOffer(
    offer: SteamTradeOfferManager.TradeOffer,
  ): Promise<CreateTradeResponse> {
    this.logger.log(`Sending offer to ${offer.partner}...`);

    this.logger.debug(
      `Items to give: [${offer.itemsToGive
        .map((item) => `"${item.appid}_${item.contextid}_${item.assetid}"`)
        .join(',')}]`,
    );
    this.logger.debug(
      `Items to receive: [${offer.itemsToReceive
        .map((item) => `"${item.appid}_${item.contextid}_${item.assetid}"`)
        .join(',')}]`,
    );

    return this._sendOffer(offer).then(() => {
      this.logger.log(
        `Offer #${offer.id} sent to ${offer.partner} has state ${
          SteamTradeOfferManager.ETradeOfferState[offer.state]
        }`,
      );

      this.sentCounter.inc();

      // Add offer to queue to ensure state and confirmation is published if needed
      this.ensureOfferPublishedQueue.push(offer).catch(() => {
        // Ignore error
      });

      return this.mapOffer(offer);
    });
  }

  private _sendOffer(offer: SteamTradeOfferManager.TradeOffer): Promise<void> {
    return new Promise((resolve, reject) => {
      offer.send((err) => {
        if (err) {
          this.logger.error(
            `Got an error while sending trade offer: ${err.message}${
              err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
            }`,
          );

          if (err.message === 'Cannot send an empty trade offer') {
            return reject(
              new BadRequestException('Cannot send an empty trade offer'),
            );
          }

          if (err.eresult !== undefined || err.cause !== undefined) {
            return reject(
              new SteamException(err.message, err.eresult, err.cause),
            );
          }

          return reject(err);
        }

        resolve();
      });
    });
  }

  async acceptTrade(id: string): Promise<TradeOffer> {
    this.logger.log(`Accepting trade offer #${id}...`);

    const offer = await this._getTrade(id);

    if (offer.state !== SteamTradeOfferManager.ETradeOfferState.Active) {
      throw new BadRequestException('Offer is not active');
    }

    const state = await this._acceptTrade(offer);

    this.logger.log(
      `Offer #${offer.id} from ${offer.partner} successfully accepted${
        state === 'pending' ? '; confirmation required' : ''
      }`,
    );

    // Set accept time to result in confirmation being published again
    offer.data('accept', Date.now());

    // Add offer to queue to ensure state and confirmation is published if needed
    this.ensureOfferPublishedQueue.push(offer).catch(() => {
      // Ignore error
    });

    return this.mapOffer(offer);
  }

  private _acceptTrade(
    offer: SteamTradeOfferManager.TradeOffer,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      offer.accept(false, (err, state) => {
        if (err) {
          this.logger.error(
            `Got an error while accepting trade offer: ${err.message}${
              err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
            }`,
          );

          if (err.eresult !== undefined || err.cause !== undefined) {
            return reject(
              new SteamException(err.message, err.eresult, err.cause),
            );
          }

          return reject(err);
        }

        return resolve(state);
      });
    });
  }

  acceptConfirmation(id: string): Promise<void> {
    this.logger.log(`Accepting confirmation for offer #${id}...`);

    return new Promise<void>((resolve, reject) => {
      this.community.acceptConfirmationForObject(
        this.configService.getOrThrow<SteamAccountConfig>('steam')
          .identitySecret,
        id,
        (err) => {
          if (err) {
            this.logger.error(
              `Error while accepting confirmation for ${id}: ${err.message}${
                err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
              }`,
            );

            if (
              err.message ===
              'Could not find confirmation for object ' + id
            ) {
              return reject(new NotFoundException('Confirmation not found'));
            }

            return reject(err);
          }

          return resolve();
        },
      );
    }).then(() => {
      this.logger.log(`Accepted confirmation for offer #${id}!`);
      this.manager.doPoll();
    });
  }

  removeTrade(id: string): Promise<TradeOffer> {
    this.logger.debug('Removing trade offer #' + id + '...');

    return new Promise<TradeOffer>((resolve, reject) => {
      this.manager.getOffer(id, (err, offer) => {
        if (err) {
          if (err.message === 'NoMatch') {
            return reject(new BadRequestException('Trade offer not found'));
          }

          return reject(err);
        }

        if (
          offer.state !== SteamTradeOfferManager.ETradeOfferState.Active &&
          offer.state !==
            SteamTradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation
        ) {
          return reject(new BadRequestException('Offer is not active'));
        }

        offer.cancel((err) => {
          if (err) {
            this.logger.error(
              `Error while removing trade offer #${id}: ${err.message}${
                err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
              }`,
            );

            if (
              err.message ===
              `Offer #${offer.id} is not active, so it may not be cancelled or declined`
            ) {
              return reject(new BadRequestException('Offer is not active'));
            } else if (err.eresult !== undefined || err.cause !== undefined) {
              return reject(new SteamException(err.message, err.eresult));
            }

            return reject(err);
          }

          return resolve(this.mapOffer(offer));
        });
      });
    }).then((offer) => {
      this.logger.debug('Removed trade offer #' + id);
      return offer;
    });
  }

  async getExchangeDetails(id: string): Promise<TradeOfferExchangeDetails> {
    const offer = await this._getTrade(id);

    return new Promise((resolve, reject) => {
      offer.getExchangeDetails(
        false,
        (err, status, tradeInitTime, receivedItems, sentItems) => {
          if (err) {
            return reject(err);
          }

          return resolve({
            status,
            tradeInitTime: Math.floor(tradeInitTime.getTime() / 1000),
            receivedItems,
            sentItems,
          });
        },
      );
    });
  }

  async getReceivedItems(id: string): Promise<Item[]> {
    const offer = await this._getTrade(id);

    if (offer.state !== SteamTradeOfferManager.ETradeOfferState.Accepted) {
      throw new BadRequestException('Offer is not accepted');
    }

    return new Promise((resolve, reject) => {
      offer.getReceivedItems((err, items) => {
        if (err) {
          return reject(err);
        }

        return resolve(items);
      });
    });
  }

  private mapOffer(offer: SteamTradeOfferManager.TradeOffer): TradeOffer {
    return {
      partner: offer.partner.getSteamID64(),
      id: offer.id,
      message: offer.message,
      state: offer.state,
      itemsToGive: offer.itemsToGive,
      itemsToReceive: offer.itemsToReceive,
      isGlitched: offer.isGlitched(),
      isOurOffer: offer.isOurOffer,
      createdAt: Math.floor(offer.created.getTime() / 1000),
      updatedAt: Math.floor(offer.updated.getTime() / 1000),
      expiresAt: Math.floor(offer.expires.getTime() / 1000),
      tradeID: offer.tradeID,
      fromRealTimeTrade: offer.fromRealTimeTrade,
      confirmationMethod: offer.confirmationMethod,
      escrowEndsAt:
        offer.escrowEnds === null
          ? null
          : Math.floor(offer.escrowEnds.getTime() / 1000),
    };
  }
}
