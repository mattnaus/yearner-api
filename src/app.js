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

app.get("/v1/investment/:wallet", async (req, res) => {
    const wallet = req.params.wallet;
    const contract = "0x25212Df29073FfFA7A67399AcEfC2dd75a831A1A";

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
            q.Map(
                q.Paginate(
                    q.Match(
                        q.Index("trans_by_wallet_by_fund"),
                        "0xeb830b5f15649e4ba098affa5e811b30bac64b88",
                        "0x25212Df29073FfFA7A67399AcEfC2dd75a831A1A"
                    )
                ),
                q.Lambda(
                    "trans",
                    q.Let(
                        {
                            transaction: q.Get(q.Var("trans")),
                        },
                        {
                            date: q.Select(["data", "date"], q.Var("transaction")),
                            type: q.Select(["data", "type"], q.Var("transaction")),
                            amount: q.Select(["data", "amount"], q.Var("transaction")),
                        }
                    )
                )
            )
        );
    } catch (err) {}

    //console.log(returnObjTrans);

    // determine the date on which the wallet first bought shares in the fund (sticking with first result; will need improvement soon though)
    const temp = returnObjTrans.data[0].date.split("-");
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

    //console.log(returnObjHistory);

    let investmentArray = [];
    let totalShares = returnObjTrans.data.find((x) => x.date === shared.dateFormat(firstDate)).amount;
    console.log(totalShares);

    // starting from the above date, loop through every day until the correct day
    for (firstDate; firstDate <= today; firstDate.setDate(firstDate.getDate() + 1)) {
        // for each day, check for increase/decrease in number of shares
        // determine the value of total number of shares in this fund
        let dateString = shared.dateFormat(firstDate);
        let sharePrice = returnObjHistory.data.find((x) => x.date === dateString).value;

        let adjustment = returnObjTrans.data.find((x) => x.date === dateString);
        if (adjustment && adjustment.type === "in") totalShares += adjustment.amount;

        let tempObject = {
            date: dateString,
            value: shared.round2Dec(totalShares * sharePrice),
            shares: totalShares,
        };
        investmentArray.push(tempObject);
    }

    res.json(investmentArray);
});

app.get("/v1/updateWallet/:wallet", async (req, res, next) => {
    const wallet = req.params.wallet;

    // verify wallet address is valid
    if (!web3.utils.isAddress(wallet)) {
        next(ApiError.internal("Provided wallet address is not valid."));
        return;
    }

    // get funds
    let returnObjFaunaGetWallet;
    try {
        returnObjFaunaGetWallet = await client.query(
            q.Let(
                {
                    wallet: q.Get(q.Match(q.Index("wallet"), "0xEB830b5f15649e4ba098aFfA5E811B30bac64B88")),
                },
                {
                    wallet: q.Select(["data", "wallet"], q.Var("wallet")),
                    funds: q.Map(
                        q.Select(["data", "funds"], q.Var("wallet")),
                        q.Lambda(
                            "addr",
                            q.Let(
                                {
                                    fundDoc: q.Get(q.Match(q.Index("fund_by_contract"), q.Var("addr"))),
                                },
                                {
                                    name: q.Select(["data", "name"], q.Var("fundDoc")),
                                    contract: q.Select(["data", "contract"], q.Var("fundDoc")),
                                    abi: q.Select(["data", "ABI"], q.Var("fundDoc")),
                                }
                            )
                        )
                    ),
                }
            )
        );
    } catch (err) {
        next(ApiError.internal("Can not load funds", err));
        return;
    }

    if (returnObjFaunaGetWallet.funds.length > 0) {
        for (let fund of returnObjFaunaGetWallet.funds) {
            abiDecoder.addABI(fund.abi);

            let returnObj = {
                data: {},
            };
            while (returnObj.data.result === undefined) {
                returnObj = await axios({
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
                                fromBlock: "0x1",
                                fromAddress: returnObjFaunaGetWallet.wallet.toLowerCase(),
                                toAddress: fund.contract.toLowerCase(),
                            },
                        ],
                    }),
                });
            }

            let transfers = returnObj.data.result.transfers;

            for (let trans of transfers) {
                //console.log(trans);
                let transObject = await axios({
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

                //console.log(transObject.data.result);

                let decodedLogs = abiDecoder.decodeLogs(transObject.data.result.logs);
                /*console.log(
                    util.inspect(decodedLogs, {
                        showHidden: false,
                        depth: null,
                        colors: true,
                    })
                );*/
                for (let event of decodedLogs) {
                    if (event.name === "Transfer") {
                        // only process Transfer type events
                        // find the "receiver" object
                        if (
                            event.events.find((x) => x.name === "receiver").value ===
                            returnObjFaunaGetWallet.wallet.toLowerCase()
                        ) {
                            // we now have the object related to the Vault token transfer to the investing wallet

                            // figure out the date that goes with the block number for the current transaction
                            let block = await web3.eth.getBlock(parseInt(transObject.data.result.blockNumber, 16));

                            console.log(new Date(block.timestamp * 1000));

                            let amount = web3.utils.fromWei(
                                event.events.find((y) => y.name === "value").value,
                                "ether"
                            );

                            let saveTransaction;
                            try {
                                saveTransaction = client.query(
                                    q.Create(q.Collection("transactions"), {
                                        data: {
                                            wallet: returnObjFaunaGetWallet.wallet.toLowerCase(),
                                            fund: fund.contract,
                                            type: "in",
                                            amount: shared.round2Dec(Number(amount)),
                                            blockNumber: transObject.data.result.blockNumber,
                                            date: shared.dateFormat(new Date(block.timestamp * 1000)),
                                        },
                                    })
                                );
                            } catch (error) {}
                        }
                    }
                }
                console.log("--- --- ---");
                console.log("--- --- ---");
                console.log("--- --- ---");
                console.log("--- --- ---");
            }
        }
    }

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
