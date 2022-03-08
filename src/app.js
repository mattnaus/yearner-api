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
            q.Map(q.Paginate(q.Match(q.Index("all_funds_sorted_name"))), q.Lambda(["name", "ref"], q.Get(q.Var("ref"))))
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

app.get("/v1/funds/:fund", async (req, res, next) => {
    const fund = req.params.fund;

    let returnObjFaunaGetFunds = await shared.getFund(fund, next);

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

app.get("/v1/investment/:wallet/:fund", async (req, res, next) => {
    const wallet = req.params.wallet.toLowerCase();
    const contract = req.params.fund.toLowerCase();
    let updateTransactions = false;

    const fund = await shared.getFund(contract, next);

    // verify wallet address is valid
    if (!web3.utils.isAddress(wallet)) {
        next(ApiError.internal("Provided wallet address is not valid."));
        return;
    }

    // does wallet exist?
    let walletObj = await shared.getWallet(wallet, next);

    // if not create
    if (walletObj.data.length === 0) {
        // since wallet did not exist, connection with fund also did not exist
        await shared.addWallet(wallet, contract, next);
        walletObj = await shared.getWallet(wallet, next);
        updateTransactions = true;
    } else {
        // wallet exists, but does it have a connection to the fund?
        if (walletObj.data[0].data.funds.find((el) => el.fund === contract) === undefined) {
            // no connection
            console.log("no connection");
            await shared.addFundToWallet(wallet, contract, next);
            walletObj = await shared.getWallet(wallet, next);
            updateTransactions = true;
        } else {
            // connection
            console.log("connection");
        }
    }

    /*res.json({
        fund: fund.data[0].data,
        history: [],
        transactions: [],
    });
    return false;*/

    if (updateTransactions) {
        // let's run this asynchronously as to not hold everything up
        shared.processTransactionsForWalletPlusFund(wallet, fund.data[0].data, process.env.MIGRATION_CONTRACT);
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
                    fund: q.Var("fund"),
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
    } catch (err) {
        next(ApiError.internal("Can not fund by contract ", err));
        return false;
    }

    console.log(returnObjTrans.transactions);

    if (returnObjTrans.transactions.data.length !== 0) {
        for (let transaction of returnObjTrans.transactions.data) {
            transaction.valueToday = shared.round2Dec(transaction.shares * returnObjTrans.sharePrice);
            transaction.perc = shared.round2Dec(
                ((transaction.valueToday - transaction.amount) / transaction.amount) * 100
            );
        }
    } else {
        // Ok, so no transaction data for this wallet + fund combo
        // is that a currently definitive NO?
        console.log(walletObj.data[0].data.funds.find((el) => el.fund === contract).trans);

        res.json({
            fund: returnObjTrans.fund.data,
            history: walletObj.data[0].data.funds.find((el) => el.fund === contract).trans ? [] : false,
            transactions: walletObj.data[0].data.funds.find((el) => el.fund === contract).trans ? [] : false,
        });
        return false;
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
    } catch (err) {
        next(ApiError.internal("Can not load history by fund ", err));
        return false;
    }

    let investmentArray = [];
    let totalShares = 0;

    for (let dateItem of returnObjHistory.data) {
        //console.log(dateItem);

        dateString = dateItem.date;

        let sharePrice = dateItem.value;

        let adjustment = returnObjTrans.transactions.data.find((x) => x.date === dateString);

        if (adjustment && adjustment.type) totalShares += adjustment.shares;

        if (totalShares === 0) continue;

        let tempObject = {
            date: dateString,
            value: shared.round2Dec(totalShares * sharePrice),
            shares: totalShares,
        };
        investmentArray.push(tempObject);
    }

    res.json({
        fund: returnObjTrans.fund.data,
        history: investmentArray,
        transactions: returnObjTrans.transactions.data,
    });
});

/*app.get("/v1/updateWallet/:wallet", async (req, res, next) => {
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
        await shared.processTransactionsForWalletPlusFund(wallet, fund, migrationContract);
    }

    console.log("Done with wallet " + wallet);
    console.log("--- --- --- ---");
    console.log("--- --- --- ---");
    console.log("--- --- --- ---");

    res.send(wallet);
});*/

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
