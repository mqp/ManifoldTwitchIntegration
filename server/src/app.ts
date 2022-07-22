import express, { Express } from "express";
import { AddressInfo } from "net";
import fetch from "node-fetch";
import { Client } from "tmi.js";
import moment from "moment";
import { Server } from "socket.io";
import http from "http";
import fs from "fs";

import * as ManifoldAPI from "common/manifold-defs";
import { FullBet } from "common/transaction";

const APIBase = "https://dev.manifold.markets/api/v0/";

const regexpCommand = new RegExp(/!([a-zA-Z0-9]+)\s?(\S*)?/);

const USER_FILE_GUID = "{5d7b6761-0719-4819-a9b9-4dd600f45369}"; // 22/07/2022

class User {
    manifoldUsername: string;
    APIKey: string;
}

export default class App {
    readonly app: Express;
    readonly latestBets: FullBet[] = [];
    readonly io: Server;

    readonly userList = {};

    pendingBets: ManifoldAPI.Bet[] = [];
    pendingFetches = {};

    userIdToNameMap: Record<string, string> = {};

    constructor() {
        this.app = express();

        const server = http.createServer(this.app);
        this.io = new Server(server);
        this.io.on("connection", (socket) => {
            console.log("A client connected by websocket: " + socket.id);
            socket.emit("clear");
            socket.emit("selectmarket", "this-is-a-local-market");
            socket.emit("bets", this.latestBets);
        });
        server.listen(3000, () => {
            const address = <AddressInfo> server.address();
            console.log(`Websocket listening on ${address.address}:${address.port}`);
        });

        moment.updateLocale("en", {
            relativeTime: {
                future: "in %s",
                past: "%s ago",
                s: "<1m",
                ss: "%ss",
                m: "1m",
                mm: "%dm",
                h: "1h",
                hh: "%dh",
                d: "1d",
                dd: "%dd",
                M: "1m",
                MM: "%dM",
                y: "1y",
                yy: "%dY",
            },
        });

        const rawData = fs.readFileSync("data/users.json");
        const rawDataString = rawData.toString();
        if (rawDataString.length > 0) {
            const data = JSON.parse(rawDataString);
            if (data.version === USER_FILE_GUID) {
                this.userList = data.userData;
            }
            else {
                console.log("User data file version mismatch. Data not loaded.");
            }
        }
        console.log(this.userList);
    }

    private saveUsersToFile() {
        const data = {
            version: USER_FILE_GUID,
            userData: this.userList,
        }
        fs.writeFile("data/users.json", JSON.stringify(data, null, 2), {flag: "w+"}, err => {
            if (err) {
                console.error(err);
            }
        }); 
    }

    loadUser(userId: string) {
        if (this.pendingFetches[userId]) {
            return;
        }
        this.pendingFetches[userId] = userId;
        fetch(`${APIBase}user/by-id/${userId}`)
            .then((r) => <Promise<ManifoldAPI.LiteUser>>r.json())
            .then((user) => {
                console.log(`Loaded user ${user.name}.`);
                delete this.pendingFetches[userId];
                this.userIdToNameMap[user.id] = user.name;


                //!!! Move this / tidy up
                // const userObj = new User();
                // userObj.username = user.username;
                // userObj.APIKey = "1234567";

                const betsToRemove = [];
                for (const bet of this.pendingBets) {
                    if (user.id == bet.userId) {
                        const fullBet: FullBet = {
                            ...bet,
                            username: user.name,
                        };
                        this.addBet(fullBet);
                        betsToRemove.push(bet);
                    }
                }
                this.pendingBets = this.pendingBets.filter((e) => {
                    return betsToRemove.indexOf(e) < 0;
                });
            })
            .catch((e) => {
                console.error(e);
            });
    }

    addBet(bet: FullBet) {
        if (this.latestBets.length >= 3) {
            this.latestBets.shift();
        }
        this.latestBets.push(bet);
        this.io.emit("bets", [bet]);

        console.log(`[${new Date().toLocaleTimeString()}] ${bet.username} ${bet.amount > 0 ? "bought" : "sold"} M$${Math.floor(Math.abs(bet.amount)).toFixed(0)} of ${bet.outcome} at ${(100 * bet.probAfter).toFixed(0)}% ${moment(bet.createdTime).fromNow()}`);
    }

    async getCurrentUserStake_shares(): Promise<{shares: number, outcome: "YES" | "NO"}> {
        return fetch(`${APIBase}bets?market=this-is-a-local-market&username=PhilBladen`)
        .then(r => <Promise<ManifoldAPI.Bet[]>> r.json())
        .then(bets => {
            let total = 0;
            for (const bet of bets) {
                if (bet.outcome == "YES") {
                    total += bet.shares;
                }
                else {
                    total -= bet.shares;
                }
            }
            return {shares: Math.abs(total), outcome: total > 0 ? "YES" : "NO"};
        });
    }

    //!!! Currently uses the Firebase API - should be updated to the Manifold REST API when possible
    async sellAllShares(username: string) {
        if (!this.userList[username]) {
            console.error(`No user record for username ${username}`);
            return;
        }
        const APIKey = this.userList[username].APIKey;

        const stake = await this.getCurrentUserStake_shares();
        if (Math.abs(stake.shares) < 1) {
            return;
        }

        try {
            const requestData = {
                contractId: "litD59HFH1eUx5sAGCNL", //!!! Not using current market info
                outcome: stake.outcome,
                shares: stake.shares,
            }
    
            const response = await fetch(`https://sellshares-w3txbmd3ba-uc.a.run.app`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Key ${APIKey}`
                },
                body: JSON.stringify(requestData),
            });
            if (response.status !== 200) {
                const error = <{message: string}> await response.json();
                throw new Error(error.message);
            }
            console.log("Shares sold successfully.");
        }
        catch (e) {
            console.error(e);
        }
    }

    async placeBet(username: string, amount: number, yes: boolean) {
        if (!this.userList[username]) {
            console.error(`No user record for username ${username}`);
            return;
        }
        const APIKey = this.userList[username].APIKey;

        const requestData = {
            amount: amount,
            contractId: "litD59HFH1eUx5sAGCNL", //!!! Not using current market info
            outcome: yes ? "YES" : "NO",
        };

        try {
            const response = await fetch(`${APIBase}bet`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Key ${APIKey}`,
                },
                body: JSON.stringify(requestData),
            });
            if (response.status != 200) {
                const text = await response.text();
                throw Error(text);
            }
        }
        catch (e) {
            console.error(e);
        }
    }

    launch() {
        const commands = {
            help: {
                response: () => "- !bet yes# - bets on yes (where # is the number of mana bet)\n" +
                 "- !bet no# - bets on no (where # is the number of mana bet)\n" + 
                 "- !allin\n" + "- !sell - sells all shares\n" + 
                 "- !balance - Manifold Bot replies your balance to you in main chat\n" + 
                 "- !help - Manifold Bot sends a DM showing list of commands\n" + 
                 "- !signup - Manifold Bot sends a DM explaining how to link accounts and free Mana on sign up.",
            },
            upvote: {
                response: (username: string, argument: string) => `Successfully upvoted ${argument}`,
            },
            bet: {
                response: (username: string, argument: string) => {
                    if (argument.startsWith("yes")) {
                        try {
                            const value = Number.parseInt(argument.substring(3));
                            if (isNaN(value)) {
                                return null;
                            }

                            this.placeBet(username, value, true);

                            return null;
                        } catch (e) {
                            return null; //!!!
                        }
                    } else if (argument.startsWith("no")) {
                        try {
                            const value = Number.parseInt(argument.substring(2));
                            if (isNaN(value)) {
                                return null; //!!!
                            }

                            this.placeBet(username, value, false);

                            return ""; //`@${username} has bet ${value} on NO!`;
                        } catch (e) {
                            return null; //!!!
                        }
                    } else {
                        return null; //!!!
                    }
                },
            },
            sell: {
                response: (username: string) => { //!!! This needs to look at the currently owned shares by the user and calculate yes or no from that
                    this.sellAllShares(username);
                    return null;
                },
            },
            balance: {
                response: (username: string, argument: string, client: Client, channel: string) => {
                    fetch(`${APIBase}user/${this.userList[username].manifoldUsername}`) //!!! Catch missing username
                    .then(r => <Promise<ManifoldAPI.LiteUser>> r.json())
                    .then(r => {
                        console.log(r);
                        client.say(channel, `@${username} currently has ${Math.floor(r.balance).toFixed(0)} mana.`);
                    })
                    return null;
                }
            },
            link: {
                response: (username: string, argument: string, client: Client, channel: string) => {
                    fetch(`${APIBase}bet`, {
                        method: "POST",
                        headers: {
                            "Authorization": `Key ${argument}`,
                        }
                    })
                    .then(r => {
                        console.log("Status: " + r.status);
                        if (r.status != 403) {
                            const user = new User();
                            user.manifoldUsername = "PhilBladen";//!!! TEMPORARY
                            user.APIKey = argument;
                            this.userList[username] = user;
                            this.saveUsersToFile();
                            client.say(channel, "Successfully linked Twitch account.");
                        }
                        return r.json();
                    })
                    .then(r => {
                        console.log(r);
                    });
                    return null;
                }
            }
        };

        let latestLoadedBetId: string = null;
        const pollLatestMarketBets = (numBetsToLoad = 10) => {
            const marketSlug = "this-is-a-local-market"; //will-elon-musk-buy-twitter-this-yea

            fetch(`${APIBase}bets?market=${marketSlug}&limit=${numBetsToLoad}`)
                .then((r) => <Promise<ManifoldAPI.Bet[]>>r.json())
                .then((bets) => {
                    if (bets.length == 0) {
                        return;
                    }

                    const newBets: ManifoldAPI.Bet[] = [];

                    let foundPreviouslyLoadedBet = latestLoadedBetId == null;
                    for (const bet of bets) {
                        try {
                            if (bet.id == latestLoadedBetId) {
                                foundPreviouslyLoadedBet = true;
                                break;
                            }

                            newBets.push(bet);
                        } catch (e) {
                            // Empty
                        }
                    }
                    newBets.reverse();
                    for (const bet of newBets) {
                        const username = this.userIdToNameMap[bet.userId];
                        if (!bet.isRedemption) {
                            if (!username) {
                                this.loadUser(bet.userId);
                                this.pendingBets.push(bet);
                            } else {
                                const fullBet: FullBet = {
                                    ...bet,
                                    username: username,
                                };
                                this.addBet(fullBet);
                            }
                        }
                    }
                    if (!foundPreviouslyLoadedBet) {
                        console.log("Failed to find previously loaded bet. Expanding search...");
                        pollLatestMarketBets(10); //!!! Need to test
                    }
                    latestLoadedBetId = bets[0].id;
                })
                .catch((e) => console.error(e));
        };
        setInterval(pollLatestMarketBets, 1000);

        // this.app.get("/transactions", (request, response) => {
        //     response.json(this.latestBets);
        // });

        const server = this.app.listen(9172, () => {
            const host = (<AddressInfo>server.address()).address;
            const port = (<AddressInfo>server.address()).port;
            console.log("Example app listening at http://%s:%s", host, port);
        });

        const client = new Client({
            options: { debug: true },
            connection: {
                secure: true,
                reconnect: true,
            },
            identity: {
                username: "manifoldbot",
                password: process.env.TWITCH_OAUTH_TOKEN,
            },
            channels: ["philbladen"],
        });

        client.connect();

        client.on("message", (channel, tags, message, self) => {
            if (self) return; // Ignore echoed messages.

            const found = message.match(regexpCommand);

            if (!found) return;
            if (found.length < 2) return;

            const command: string = found[1];
            const argument: string = found[2];

            const commandObject = commands[command as keyof typeof commands];
            if (!commandObject) {
                return;
            }
            const response: (a: string, b: string, c: Client, d: string) => string | null = commandObject.response;

            let responseMessage;

            if (tags.username) {
                responseMessage = response(tags.username, argument, client, channel);
            }

            if (responseMessage) {
                const lines = responseMessage.split("\n");
                console.log(`Responding to command !${command}`);
                for (const line of lines) {
                    client.say(channel, line);
                }
            }
        });

        client.on("connected", () => {
            const options = client.getOptions();
            if (!options.channels) {
                return;
            }
            const channel = options.channels[0];
            client.say(channel, "/clear");
            client.say(channel, "/color BlueViolet");
        });
    }
}
