import { Injectable, Logger } from '@nestjs/common';
import SteamUser from 'steam-user';
import SteamID from 'steamid';
import {
  FriendMessageEvent,
  FriendRelationshipEvent,
  Friends,
  FriendTypingEvent,
  FRIEND_MESSAGE_EVENT,
  FRIEND_RELATIONSHIP_EVENT,
  FRIEND_TYPING_EVENT,
  SendFriendMessageResponse,
} from '@tf2-automatic/bot-data';
import { BotService } from '../bot/bot.service';
import { EventsService } from '../events/events.service';

@Injectable()
export class FriendsService {
  private readonly logger = new Logger(FriendsService.name);

  private readonly client = this.botService.getClient();

  constructor(
    private readonly botService: BotService,
    private readonly eventsService: EventsService
  ) {
    // @ts-ignore
    this.client.on(
      'friendRelationship',
      (steamID, relationship, oldRelationship) => {
        this.eventsService
          .publish(FRIEND_RELATIONSHIP_EVENT, {
            steamid64: steamID.getSteamID64(),
            relationship,
            oldRelationship,
          } as FriendRelationshipEvent['data'])
          .catch(() => {
            // Ignore error
          });
      }
    );

    this.client.chat.on('friendTyping', (message) => {
      this.eventsService
        .publish(FRIEND_TYPING_EVENT, {
          steamid64: message.steamid_friend.getSteamID64(),
          timestamp: Math.floor(message.server_timestamp.getTime() / 1000),
          ordinal: message.ordinal,
        } as FriendTypingEvent['data'])
        .catch(() => {
          // Ignore error
        });
    });

    this.client.chat.on('friendMessage', (message) => {
      this.eventsService
        .publish(FRIEND_MESSAGE_EVENT, {
          steamid64: message.steamid_friend.getSteamID64(),
          timestamp: Math.floor(message.server_timestamp.getTime() / 1000),
          ordinal: message.ordinal,
          message: message.message,
        } as FriendMessageEvent['data'])
        .catch(() => {
          // Ignore error
        });
    });
  }

  async getFriends(): Promise<Friends> {
    return Object.keys(this.client.myFriends).map((steamid) => {
      const relationship = this.client.myFriends[steamid];

      return {
        steamid64: steamid,
        isFriend: relationship === SteamUser.EFriendRelationship.Friend,
        isInvited:
          relationship === SteamUser.EFriendRelationship.RequestInitiator,
        hasInvitedUs:
          relationship === SteamUser.EFriendRelationship.RequestRecipient,
      };
    });
  }

  addFriend(steamid: SteamID): Promise<boolean> {
    this.logger.debug(`Adding friend ${steamid.getSteamID64()}...`);

    return new Promise<boolean>((resolve, reject) => {
      this.client.addFriend(steamid, (err) => {
        if (err) {
          if (err.message === 'DuplicateName') {
            // Already friends
            return resolve(false);
          }

          return reject(err);
        }

        return resolve(true);
      });
    })
      .then((added) => {
        if (added) {
          this.logger.debug(`Added friend ${steamid.getSteamID64()}`);
        } else {
          this.logger.debug(`Already friends with ${steamid.getSteamID64()}`);
        }
        return added;
      })
      .catch((err) => {
        this.logger.error('Error adding friend: ' + err.message);
        throw err;
      });
  }

  deleteFriend(steamid: SteamID): Promise<void> {
    this.logger.debug(`Deleting friend ${steamid.getSteamID64()}...`);

    return new Promise<void>((resolve, reject) => {
      this.client.removeFriend(steamid);

      const timeout = setTimeout(() => {
        this.client.removeListener('friendRelationship', listener);
        reject(new Error('Timeout'));
      }, 5000);

      const listener = (
        sid: SteamID,
        relationship: SteamUser.EFriendRelationship
      ) => {
        if (
          steamid.getSteamID64() === sid.getSteamID64() &&
          relationship === SteamUser.EFriendRelationship.None
        ) {
          clearTimeout(timeout);
          return resolve();
        }
      };

      this.client.once('friendRelationship', listener);
    })
      .then(() => {
        this.logger.debug(`Deleted friend ${steamid.getSteamID64()}`);
      })
      .catch((err) => {
        this.logger.error('Error deleting friend: ' + err.message);
        throw err;
      });
  }

  async isFriend(steamid: SteamID): Promise<boolean> {
    return (
      this.client.myFriends[steamid.getSteamID64()] ===
      SteamUser.EFriendRelationship.Friend
    );
  }

  async isInvited(steamid: SteamID): Promise<boolean> {
    return (
      this.client.myFriends[steamid.getSteamID64()] ===
      SteamUser.EFriendRelationship.RequestInitiator
    );
  }

  async hasInvitedUs(steamid: SteamID): Promise<boolean> {
    return (
      this.client.myFriends[steamid.getSteamID64()] ===
      SteamUser.EFriendRelationship.RequestRecipient
    );
  }

  sendFriendMessage(
    steamid: SteamID,
    message: string
  ): Promise<SendFriendMessageResponse> {
    return this.client.chat
      .sendFriendMessage(steamid, message)
      .then((result) => {
        return {
          modified_message: result.modified_message,
          server_timestamp: Math.floor(
            result.server_timestamp.getTime() / 1000
          ),
          ordinal: result.ordinal,
        };
      });
  }

  sendFriendTyping(steamid: SteamID): Promise<void> {
    return this.client.chat.sendFriendTyping(steamid).then(() => undefined);
  }
}
