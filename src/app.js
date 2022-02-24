const express = require("express");
const shared = require("./shared/utils.js");
const fauna = require("faunadb");
const apiErrorHandler = require("./error/api-error-handler.js");
const ApiError = require("./error/ApiError.js");
const dotenv = require("dotenv");
const util = require("util");
const abiDecoder = require("abi-decoder");
dotenv.config();

const { createAlchemyWeb3 } = require("@alch/alchemy-web3");
const web3 = createAlchemyWeb3("https://eth-mainnet.alchemyapi.io/v2/***REMOVED***");
const axios = require("axios");

const app = express();
const port = process.env.PORT || 3000;

const q = fauna.query;
const client = new fauna.Client({
    secret: process.env.FAUNA_SECRET,
});

const returnHeaders = {
    "Access-Control-Allow-Credentials": true,
    "Access-Control-Expose-Headers": "X-Total-Count",
    "Access-Control-Allow-Headers": "*",
    "ACCESS-CONTROL-ALLOW-METHODS": "GET",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
};

app.get("/v1/funds", async (req, res) => {
    // grab all funds
    let returnObjFaunaGetFunds;
    try {
        returnObjFaunaGetFunds = await client.query(
            q.Map(q.Paginate(q.Match(q.Index("all_funds"))), q.Lambda("x", q.Get(q.Var("x"))))
        );
    } catch (error) {
        console.log(error);
    }

    let funds = [];

    if (returnObjFaunaGetFunds.data.length !== 0) {
        for (let fund of returnObjFaunaGetFunds.data) {
            if (fund.data.hasOwnProperty("lastUpdate")) {
                console.log(fund);
                let tempFund = {};
                tempFund.ref = fund.ref.id;
                tempFund.name = fund.data.name;
                tempFund.contract = fund.data.contract;
                tempFund.activationBlock = fund.data.activationBlock;
                tempFund.lastUpdate = fund.data.lastUpdate;
                tempFund.stats = fund.data.stats;
                tempFund.sharePrice = fund.data.sharePrice;
                tempFund.totalAssets = fund.data.totalAssets;
                tempFund.availableShares = fund.data.availableShares;
                tempFund.tokenSymbol = fund.data.tokenSymbol;
                tempFund.tokenContract = fund.data.tokenContract;
                funds.push(tempFund);
            }
        }
    }

    res.set(returnHeaders);

    res.status(200).json(funds);
});

app.get("/v1/funds/:fund", async (req, res) => {
    const fund = req.params.fund;

    let returnObjFaunaGetFunds;
    try {
        returnObjFaunaGetFunds = await client.query(
            q.Map(q.Paginate(q.Match(q.Index("fund_by_contract"), fund)), q.Lambda("x", q.Get(q.Var("x"))))
        );
    } catch (error) {
        console.log(error);
    }

    res.set(returnHeaders);

    res.status(200).json(returnObjFaunaGetFunds.data[0].data);
});

app.get("/v1/history", async (req, res) => {
    const contract = req.query.contract;

    let returnObjFaunaGetHistory = [];

    if (contract === undefined || contract === "") {
        try {
            returnObjFaunaGetHistory = await client.query(
                q.Map(
                    q.Paginate(q.Match(q.Index("all_history")), {
                        size: 100000,
                    }),
                    q.Lambda("X", {
                        date: q.Select(["data", "date"], q.Get(q.Var("X"))),
                        value: q.ToNumber(q.Select(["data", "value"], q.Get(q.Var("X")))),
                    })
                )
            );
        } catch (error) {}
    } else {
        try {
            returnObjFaunaGetHistory = await client.query(
                q.Map(
                    q.Paginate(q.Match(q.Index("history_by_fund"), contract), {
                        size: 100000,
                    }),
                    q.Lambda("X", {
                        date: q.Select(["data", "date"], q.Get(q.Var("X"))),
                        value: q.ToNumber(q.Select(["data", "value"], q.Get(q.Var("X")))),
                    })
                )
            );
        } catch (error) {}
    }

    res.set(returnHeaders);

    res.json(returnObjFaunaGetHistory.data);
});

app.get("/v1/history/:ref", async (req, res) => {
    const ref = req.params.ref;

    let returnObjFaunaGetHistory = [];
    try {
        returnObjFaunaGetHistory = await client.query(
            q.Map(
                q.Paginate(q.Match(q.Index("history_by_fund"), ref), {
                    size: 100000,
                }),
                q.Lambda("X", {
                    date: q.Select(["data", "date"], q.Get(q.Var("X"))),
                    value: q.Select(["data", "value"], q.Get(q.Var("X"))),
                })
            )
        );
    } catch (error) {}

    res.set(returnHeaders);

    res.send(returnObjFaunaGetHistory.data[0]);
});

app.get("/v1/investment/:wallet/:fund", async (req, res) => {
    const wallet = req.params.wallet.toLowerCase();
    const contract = req.params.fund.toLowerCase();

    // verify wallet address is valid
    if (!web3.utils.isAddress(wallet)) {
        next(ApiError.internal("Provided wallet address is not valid."));
        return;
    }

    // get transaction data for wallet+fund combo
    // ideally, an array with dates and changes to the number of shares in the fund
    let returnObjTrans;
    try {
        returnObjTrans = await client.query(
            q.Let(
                {
                    fund: q.Get(q.Match(q.Index("fund_by_contract"), contract)),
                },
                {
                    name: q.Select(["data", "name"], q.Var("fund")),
                    sharePrice: q.Select(["data", "sharePrice"], q.Var("fund")),
                    transactions: q.Map(
                        q.Paginate(q.Match(q.Index("trans_by_wallet_by_fund"), wallet, contract)),
                        q.Lambda(
                            "trans",
                            q.Let(
                                { transaction: q.Get(q.Var("trans")) },
                                {
                                    date: q.Select(["data", "date"], q.Var("transaction")),
                                    type: q.Select(["data", "type"], q.Var("transaction")),
                                    shares: q.Select(["data", "shares"], q.Var("transaction")),
                                    amount: q.Select(["data", "amount"], q.Var("transaction")),
                                }
                            )
                        )
                    ),
                }
            )
        );
    } catch (err) {}

    //console.log(returnObjTrans);

    if (returnObjTrans.transactions.data.length > 0) {
        for (let transaction of returnObjTrans.transactions.data) {
            transaction.valueToday = shared.round2Dec(transaction.shares * returnObjTrans.sharePrice);
            transaction.perc = shared.round2Dec(
                ((transaction.valueToday - transaction.amount) / transaction.amount) * 100
            );
        }
    }

    //console.log(returnObjTrans.transactions.data);

    // determine the date on which the wallet first bought shares in the fund (sticking with first result; will need improvement soon though)
    const temp = returnObjTrans.transactions.data[0].date.split("-");
    const firstDate = new Date();
    firstDate.setUTCFullYear(Number(temp[0]));
    firstDate.setUTCMonth(Number(temp[1]) - 1);
    firstDate.setUTCDate(Number(temp[2]));
    firstDate.setUTCHours(0);
    firstDate.setUTCMinutes(0);

    let today = new Date();

    // retrieve a list of price history, for the fund
    let returnObjHistory;
    try {
        returnObjHistory = await client.query(
            q.Map(
                q.Paginate(q.Match(q.Index("history_by_fund"), contract), {
                    size: 100000,
                }),
                q.Lambda("X", {
                    date: q.Select(["data", "date"], q.Get(q.Var("X"))),
                    value: q.ToNumber(q.Select(["data", "value"], q.Get(q.Var("X")))),
                })
            )
        );
    } catch (err) {}

    let investmentArray = [];
    let totalShares = 0;

    // starting from the above date, loop through every day until the correct day
    for (firstDate; firstDate <= today; firstDate.setDate(firstDate.getDate() + 1)) {
        // for each day, check for increase/decrease in number of shares
        // determine the value of total number of shares in this fund
        let dateString = shared.dateFormat(firstDate);
        console.log(dateString);
        let sharePrice = returnObjHistory.data.find((x) => x.date === dateString).value;

        let adjustment = returnObjTrans.transactions.data.find((x) => x.date === dateString);
        if (adjustment && adjustment.type === "in") totalShares += adjustment.shares;

        let tempObject = {
            date: dateString,
            value: shared.round2Dec(totalShares * sharePrice),
            shares: totalShares,
        };
        investmentArray.push(tempObject);
    }

    res.json({
        history: investmentArray,
        transactions: returnObjTrans.transactions.data,
    });
});

app.get("/v1/updateWallet/:wallet", async (req, res, next) => {
    const wallet = req.params.wallet.toLowerCase();
    const migrationContract = "***REMOVED***";

    // verify wallet address is valid
    if (!web3.utils.isAddress(wallet)) {
        next(ApiError.internal("Provided wallet address is not valid."));
        return;
    }

    // get wallet and connected funds
    let walletData = await shared.getWalletPlusFunds(wallet, next);
    console.log(walletData);

    if (walletData.funds.length === 0) {
        res.send("Wallet not invested in any funds");
        return;
    }

    console.log("Looping through funds invested in by wallet " + wallet);

    for (let fund of walletData.funds) {
        console.log("Processing " + fund.name);
        abiDecoder.addABI(fund.abi);

        let getTransfersWalletToFund = {
            data: {},
        };
        while (getTransfersWalletToFund.data.result === undefined) {
            console.log("Attempting to get transfers from " + wallet + " to " + fund.contract);
            getTransfersWalletToFund = await axios({
                method: "post",
                url: "https://eth-mainnet.alchemyapi.io/v2/***REMOVED***",
                headers: {
                    "Content-Type": "application/json",
                },
                data: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 0,
                    method: "alchemy_getAssetTransfers",
                    params: [
                        {
                            fromBlock: "0x" + fund.activationBlock.block.toString(16),
                            fromAddress: wallet,
                            toAddress: fund.contract.toLowerCase(),
                        },
                    ],
                }),
            });
        }
        console.log("Succeeding in loading transactions");

        let transfers = getTransfersWalletToFund.data.result.transfers;

        if (transfers.length > 0) {
            // next block deals with regular transfers

            console.log("Processing regular transactions.");

            for (let trans of transfers) {
                let getTransactionReceipt = await axios({
                    method: "post",
                    url: "https://eth-mainnet.alchemyapi.io/v2/***REMOVED***",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    data: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 0,
                        method: "eth_getTransactionReceipt",
                        params: [trans.hash],
                    }),
                });

                let decodedLogs = abiDecoder.decodeLogs(getTransactionReceipt.data.result.logs);

                for (let event of decodedLogs) {
                    if (event.name === "Transfer") {
                        // only process Transfer type events
                        // find the "receiver" object
                        if (event.events.find((x) => x.name === "receiver").value === wallet) {
                            // we now have the object related to the Vault token transfer to the investing wallet

                            // figure out the date that goes with the block number for the current transaction
                            let block = await web3.eth.getBlock(
                                parseInt(getTransactionReceipt.data.result.blockNumber, 16)
                            );

                            let amount = web3.utils.fromWei(
                                event.events.find((y) => y.name === "value").value,
                                "ether"
                            );

                            shared.saveTransaction(
                                wallet,
                                fund.contract,
                                "in",
                                web3.utils.fromWei(event.events.find((y) => y.name === "value").value, "ether"),
                                trans.value,
                                getTransactionReceipt.data.result.blockNumber,
                                block.timestamp,
                                getTransactionReceipt.data.result.transactionHash
                            );
                        }
                    }
                }
            }
        } else {
            // next block deals with migration transfers
            // no direct transfers, explore migrations

            console.log("Looking into possible migration transactions.");

            let getTransfersWalletToFund = {
                data: {},
            };
            while (getTransfersWalletToFund.data.result === undefined) {
                console.log("Attempting to get transfers from " + wallet + " to " + migrationContract);
                getTransfersWalletToFund = await axios({
                    method: "post",
                    url: "https://eth-mainnet.alchemyapi.io/v2/***REMOVED***",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    data: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 0,
                        method: "alchemy_getAssetTransfers",
                        params: [
                            {
                                fromBlock: "0x" + fund.activationBlock.block.toString(16),
                                fromAddress: wallet,
                                toAddress: migrationContract,
                            },
                        ],
                    }),
                });
            }

            let transfers = getTransfersWalletToFund.data.result.transfers;

            if (transfers.length > 0) {
                for (let trans of transfers) {
                    let getTransactionReceipt = await axios({
                        method: "post",
                        url: "https://eth-mainnet.alchemyapi.io/v2/***REMOVED***",
                        headers: {
                            "Content-Type": "application/json",
                        },
                        data: JSON.stringify({
                            jsonrpc: "2.0",
                            id: 0,
                            method: "eth_getTransactionReceipt",
                            params: [trans.hash],
                        }),
                    });

                    let decodedLogs = abiDecoder.decodeLogs(getTransactionReceipt.data.result.logs);
                    /*console.log(
                        util.inspect(decodedLogs, {
                            showHidden: false,
                            depth: null,
                            colors: true,
                        })
                    );*/

                    // we need to start by determining this transaction is relevant
                    // we do this by locating a log item that transfers funds from the migrationContract
                    // to the fund contract. If this log exists, it's relevant
                    let results0 = decodedLogs.filter((event) => {
                        return (
                            event.name === "Transfer" &&
                            event.events[0].name === "sender" &&
                            event.events[0].value === migrationContract &&
                            event.events[1].name === "receiver" &&
                            event.events[1].value === fund.contract
                        );
                    });

                    if (results0.length === 0) {
                        break;
                    }

                    // get the AMOUNT part (tokens transferred from wallet to migration contract)
                    let results = decodedLogs.filter((event) => {
                        return (
                            event.name === "Transfer" &&
                            event.events[0].name === "sender" &&
                            event.events[0].value === wallet &&
                            event.events[1].name === "receiver" &&
                            event.events[1].value === migrationContract
                        );
                    });

                    let amount = shared.round2Dec(Number(web3.utils.fromWei(results[0].events[2].value, "ether")));

                    // get the number of shares transferred to wallet from migrationContract
                    let results2 = decodedLogs.filter((event) => {
                        return (
                            event.name === "Transfer" &&
                            event.events[0].name === "sender" &&
                            event.events[0].value === "0x0000000000000000000000000000000000000000" &&
                            event.events[1].name === "receiver" &&
                            event.events[1].value === wallet
                        );
                    });

                    let shares = shared.round2Dec(Number(web3.utils.fromWei(results2[0].events[2].value, "ether")));

                    // figure out the date that goes with the block number for the current transaction
                    let block = await web3.eth.getBlock(parseInt(trans.blockNum, 16));

                    shared.saveTransaction(
                        wallet,
                        fund.contract,
                        "in",
                        shares,
                        amount,
                        trans.blockNum,
                        block.timestamp,
                        getTransactionReceipt.data.result.transactionHash
                    );
                }
            }
        }
    }

    console.log("Done with wallet " + wallet);
    console.log("--- --- --- ---");
    console.log("--- --- --- ---");
    console.log("--- --- --- ---");

    res.send(wallet);
});

/*app.get("/v1/updateFund/:fund", async (req, res) => {
    const fund = req.params.fund;

    //console.log(fund);
    await shared.updateContract(fund);

    res.send(fund);
});*/

app.get("/v2/funds", async (req, res) => {
    // grab all funds
    let returnObjFaunaGetFunds;
    try {
        returnObjFaunaGetFunds = await client.query(
            q.Map(q.Paginate(q.Match(q.Index("all_funds"))), q.Lambda("x", q.Get(q.Var("x"))))
        );
    } catch (error) {
        console.log(error);
    }

    let funds = [];

    if (returnObjFaunaGetFunds.data.length !== 0) {
        for (let fund of returnObjFaunaGetFunds.data) {
            if (fund.data.hasOwnProperty("lastUpdate")) {
                console.log(fund);
                let tempFund = {};
                tempFund.ref = fund.ref.id;
                tempFund.name = fund.data.name;
                tempFund.contract = fund.data.contract;
                tempFund.activationBlock = fund.data.activationBlock;
                tempFund.lastUpdate = fund.data.lastUpdate;
                tempFund.stats = fund.data.stats;
                funds.push(tempFund);
            }
        }
    }

    res.set(returnHeaders);

    res.status(200).json(funds);
});

app.get("/v2/history", async (req, res) => {
    const ref = req.query.contract;

    let data = [];

    if (ref === undefined) {
        data = [
            {
                contract: "0x25212Df29073FfFA7A67399AcEfC2dd75a831A1A",
                date: "2021-04-24",
                value: "1",
            },
            {
                contract: "0x25212Df29073FfFA7A67399AcEfC2dd75a831A1A",
                date: "2021-04-25",
                value: "2",
            },
            {
                contract: "0xdA816459F1AB5631232FE5e97a05BBBb94970c95",
                date: "2021-04-26",
                value: "3",
            },
            {
                contract: "0xdA816459F1AB5631232FE5e97a05BBBb94970c95",
                date: "2021-04-27",
                value: "3",
            },
            {
                contract: "0x8b9C0c24307344B6D7941ab654b2Aeee25347473",
                date: "2021-04-28",
                value: "5",
            },
            {
                contract: "0x8b9C0c24307344B6D7941ab654b2Aeee25347473",
                date: "2021-04-29",
                value: "6",
            },
        ];
    } else {
        if (ref === "0x25212Df29073FfFA7A67399AcEfC2dd75a831A1A") {
            data = [
                {
                    contract: "0x25212Df29073FfFA7A67399AcEfC2dd75a831A1A",
                    date: "2021-04-24",
                    value: "1",
                },
                {
                    contract: "0x25212Df29073FfFA7A67399AcEfC2dd75a831A1A",
                    date: "2021-04-25",
                    value: "2",
                },
            ];
        } else if (ref === "0xdA816459F1AB5631232FE5e97a05BBBb94970c95") {
            data = [
                {
                    contract: "0xdA816459F1AB5631232FE5e97a05BBBb94970c95",
                    date: "2021-04-26",
                    value: "3",
                },
                {
                    contract: "0xdA816459F1AB5631232FE5e97a05BBBb94970c95",
                    date: "2021-04-27",
                    value: "3",
                },
            ];
        } else {
            data = [
                {
                    contract: "0x8b9C0c24307344B6D7941ab654b2Aeee25347473",
                    date: "2021-04-28",
                    value: "5",
                },
                {
                    contract: "0x8b9C0c24307344B6D7941ab654b2Aeee25347473",
                    date: "2021-04-29",
                    value: "6",
                },
            ];
        }
    }

    res.send(data);
});

app.get("/test", async (req, res) => {
    const data = [{ one: "test" }, { two: "test" }];

    res.set({
        "Access-Control-Allow-Credentials": true,
        "Access-Control-Expose-Headers": "X-Total-Count",
        "CF-Cache-Status": "DYNAMIC",
        "Cache-Control": "no-cache",
        Expires: -1,
        Etag: 'W/"227e-gljI9fM8tGjxu+wA0kviiZ6rmN0"',
        Vary: "Origin, Accept-Encoding",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Headers": "*",
        "ACCESS-CONTROL-ALLOW-METHODS": "GET",
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
    });

    res.status(200).json(data);
});

app.listen(port, () => console.log(`sample-expressjs app listening on port ${port}!`));

app.use(apiErrorHandler);
