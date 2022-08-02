import { ChatUserstate, Client } from "tmi.js";
import App from "./app";
import fs from "fs";
import { InsufficientBalanceException, UserNotRegisteredException } from "./exceptions";
import { ResolutionOutcome } from "common/manifold-defs";
import log from "./logger";
import User from "./user";
import { Market } from "./market";

const COMMAND_REGEXP = new RegExp(/!([a-zA-Z0-9]+)\s?([\s\S]*)?/);

const BOT_USERNAME = "manifoldbot";

const SIGNUP_LINK = "http://localhost:3000/profile"; //!!!

const MSG_NOT_ENOUGH_MANA_CREATE_MARKET = (username: string, balance: number) => `Sorry ${username}, you don't have enough Mana (M$${Math.floor(balance).toFixed(0)}/M$100) to create a market LUL`;
const MSG_NOT_ENOUGH_MANA_PLACE_BET = (username: string) => `Sorry ${username}, you don't have enough Mana to place that bet`;
const MSG_SIGNUP = (username: string) => `Hello ${username}! Click here to play: ${SIGNUP_LINK}!`;
const MSG_HELP = () => `Check out the full list of commands and how to play here: ${SIGNUP_LINK}`;
const MSG_RESOLVED = (outcome: ResolutionOutcome) => `The market has resolved to ${outcome}! The top 10 bettors are name (+#), name2…`; //!!! Needs some work
const MSG_BALANCE = (username: string, balance: number) => `${username} currently has M$${Math.floor(balance).toFixed(0)}`;
const MSG_MARKET_CREATED = (username: string, question: string) => `${username}'s market '${question}' has been created!`;
const MSG_COMMAND_FAILED = (username: string, message: string) => `Sorry ${username} but that command failed: ${message}`;

export default class TwitchBot {
    private readonly app: App;

    private readonly client: Client;

    constructor(app: App) {
        this.app = app;

        const basicCommands: { [k: string]: (username: string, tags: ChatUserstate, args: string[], channel: string) => void } = {
            commands: (username: string, tags: ChatUserstate, args: string[], channel: string) => {
                this.client.say(channel, MSG_HELP());
            },
            help: (username: string, tags: ChatUserstate, args: string[], channel: string) => {
                this.client.say(channel, MSG_HELP());
            },
            signup: (username: string, tags: ChatUserstate, args: string[], channel: string) => {
                this.client.say(channel, MSG_SIGNUP(username));
            },
        };

        const betCommandHandler = async (user: User, tags: ChatUserstate, args: string[], channel: string, market: Market) => {
            if (args.length < 1) return;
            let arg = args[0].toLocaleLowerCase();
            if (args.length >= 2) {
                arg += args[1].toLocaleLowerCase();
            }
            let yes: boolean;
            if (arg.startsWith("yes")) {
                yes = true;
                arg = arg.substring(3);
            } else if (arg.endsWith("yes")) {
                yes = true;
                arg = arg.substring(0, arg.length - 3);
            } else if (arg.startsWith("no")) {
                yes = false;
                arg = arg.substring(2);
            } else if (arg.endsWith("no")) {
                yes = false;
                arg = arg.substring(0, arg.length - 2);
            } else {
                return;
            }

            const value = Number.parseInt(arg);
            if (isNaN(value)) return;

            try {
                await user.placeBet(market.data.id, value, yes);
            } catch (e) {
                if (e instanceof InsufficientBalanceException) {
                    this.client.say(channel, MSG_NOT_ENOUGH_MANA_PLACE_BET(user.twitchDisplayName));
                } else {
                    throw e;
                }
            }
        };
        
        const userCommands: { [k: string]: (user: User, tags: ChatUserstate, args: string[], channel: string, market: Market) => Promise<void> } = {
            buy: betCommandHandler,
            bet: betCommandHandler,
            sell: async (user: User, tags: ChatUserstate, args: string[], channel: string, market: Market) => {
                await user.sellAllShares(market.data.id);
            },
            allin: async (user: User, tags: ChatUserstate, args: string[], channel: string, market: Market) => {
                if (args.length < 1) return;
                const arg = args[0].toLocaleLowerCase();
                let yes: boolean;
                if (arg == "yes") {
                    yes = true;
                } else if (arg == "no") {
                    yes = false;
                } else {
                    return;
                }
                await user.allIn(market.data.id, yes);
            },
            balance: async (user: User, tags: ChatUserstate, args: string[], channel: string) => {
                const balance = await user.getBalance();
                this.client.say(channel, MSG_BALANCE(user.twitchDisplayName, balance));
            },
        };

        const modUserCommands: { [k: string]: (user: User, tags: ChatUserstate, args: string[], channel: string, market: Market) => Promise<void> } = {
            create: async (user: User, tags: ChatUserstate, args: string[], channel: string) => {
                if (!this.isAllowedAdminCommand(tags)) {
                    log.warn(`User ${user.twitchDisplayName} tried to use create without permission.`);
                    return;
                }
                if (args.length < 1) return;
                let question = "";
                for (const arg of args) {
                    question += arg + " ";
                }
                question = question.trim();

                try {
                    const market = await user.createBinaryMarket(question, null, 50);
                    log.info("Created market ID: " + market.id);
                    this.client.say(channel, MSG_MARKET_CREATED(user.twitchDisplayName, question));
                } catch (e) {
                    if (e instanceof InsufficientBalanceException) {
                        user.getBalance().then((balance) => {
                            this.client.say(channel, MSG_NOT_ENOUGH_MANA_CREATE_MARKET(user.twitchDisplayName, balance));
                        });
                    }
                }
            },
            resolve: async (user: User, tags: ChatUserstate, args: string[], channel: string, market: Market) => {
                if (!this.isAllowedAdminCommand(tags)) {
                    log.warn(`User ${user.twitchDisplayName} tried to use resolve without permission.`);
                    return;
                }
                if (args.length < 1) return;
                const resolutionString = args[0].toLocaleUpperCase();
                let outcome: ResolutionOutcome = ResolutionOutcome[resolutionString];
                if (resolutionString == "NA") {
                    outcome = ResolutionOutcome.CANCEL;
                }
                if (!outcome || outcome == ResolutionOutcome.PROB) {
                    log.info("Resolve command failed due to outcome: " + outcome);
                    return;
                }
                await user.resolveBinaryMarket(market.data.id, outcome);
                this.client.say(channel, MSG_RESOLVED(outcome));
            },
        };

        this.client = new Client({
            options: { debug: true },
            connection: {
                secure: true,
                reconnect: true,
            },
            identity: {
                username: BOT_USERNAME,
                password: process.env.TWITCH_OAUTH_TOKEN,
            },
            channels: [...this.getRegisteredChannelListFromFile()],
        });

        this.client.on("message", async (channel, tags, message, self) => {
            if (self) return; // Ignore echoed messages.

            const groups = message.match(COMMAND_REGEXP);
            if (!groups) return;
            if (groups.length < 2) return;

            const commandString: string = groups[1].toLocaleLowerCase();
            let args: string[] = groups[2]?.split(" ") || [];
            args = args.filter((value: string) => value.length > 0);

            try {
                if (basicCommands[commandString]) {
                    basicCommands[commandString](tags.username, tags, args, channel);
                } else {
                    try {
                        const market = app.getMarketForTwitchChannel(channel);
                        const user = this.app.getUserForTwitchUsername(tags.username);
                        user.twitchDisplayName = tags["display-name"];
                        if (userCommands[commandString]) {
                            await userCommands[commandString](user, tags, args, channel, market);
                        } else if (modUserCommands[commandString]) {
                            await modUserCommands[commandString](user, tags, args, channel, market);
                        }
                    } catch (e) {
                        if (e instanceof UserNotRegisteredException) this.client.say(channel, MSG_SIGNUP(tags["display-name"]));
                        throw e;
                    }
                }
            } catch (e) {
                this.client.say(channel, MSG_COMMAND_FAILED(tags["display-name"], e.message));
                log.trace(e);
            }
        });
    }

    private isAllowedAdminCommand(tags: ChatUserstate): boolean {
        if (!tags || !tags.badges) {
            return false;
        }
        if (tags.badges.moderator || tags.badges.admin || tags.badges.global_mod || tags.badges.broadcaster) {
            return true;
        }
    }

    public connect() {
        this.client.connect();
    }

    private getRegisteredChannelListFromFile(): string[] {
        try {
            const rawChannelListData = fs.readFileSync("data/channels.json");
            const rawDataString = rawChannelListData.toString();
            if (rawDataString.length > 0) {
                const data = JSON.parse(rawDataString);
                return data.channels;
            }
        } catch (e) {
            return [];
        }
    }

    private saveRegisteredChannelListToFile(): void {
        fs.writeFileSync("data/channels.json", JSON.stringify({ channels: this.client.getChannels() }));
    }

    public joinChannel(channelName: string) {
        if (this.client.getChannels().indexOf(`#${channelName}`) >= 0) {
            throw new Error(`Bot already added to channel '${channelName}'`);
        }
        this.client
            .join("#" + channelName)
            .then(() => {
                this.client.say(channelName, "/color BlueViolet");

                let message = "Hey there! I am the Manifold Markets chat bot.";
                if (!this.client.isMod(channelName, BOT_USERNAME)) {
                    message += " Please /mod me so I can do my job.";
                }
                this.client.say(channelName, message);

                this.saveRegisteredChannelListToFile();
            })
            .catch((e) => log.trace(e));
    }

    public leaveChannel(channelName: string) {
        if (this.client.getChannels().indexOf(`#${channelName}`) >= 0) {
            this.client.say(channelName, "Goodbye cruel world.");
            this.client.part(channelName).then(() => {
                this.saveRegisteredChannelListToFile();
            });
        } else {
            throw new Error(`Bot not in channel '${channelName}'`);
        }
    }
}
