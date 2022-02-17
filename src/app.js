const express = require("express");
const shared = require("./shared/utils.js");
const fauna = require("faunadb");
const apiErrorHandler = require("./error/api-error-handler.js");
const ApiError = require("./error/ApiError.js");
const dotenv = require("dotenv");
dotenv.config();

const { createAlchemyWeb3 } = require("@alch/alchemy-web3");
const web3 = createAlchemyWeb3(
    "https://eth-mainnet.alchemyapi.io/v2/***REMOVED***"
);

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
            q.Map(
                q.Paginate(q.Match(q.Index("all_funds"))),
                q.Lambda("x", q.Get(q.Var("x")))
            )
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
            q.Map(
                q.Paginate(q.Match(q.Index("fund_by_contract"), fund)),
                q.Lambda("x", q.Get(q.Var("x")))
            )
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
                        value: q.ToNumber(
                            q.Select(["data", "value"], q.Get(q.Var("X")))
                        ),
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
                        value: q.ToNumber(
                            q.Select(["data", "value"], q.Get(q.Var("X")))
                        ),
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

app.get("/v1/updateWallet/:wallet", async (req, res, next) => {
    const wallet = req.params.wallet;

    // verify wallet address is valid
    if (!web3.utils.isAddress(wallet)) {
        next(ApiError.internal("Provided wallet address is not valid."));
        return;
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
            q.Map(
                q.Paginate(q.Match(q.Index("all_funds"))),
                q.Lambda("x", q.Get(q.Var("x")))
            )
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

app.listen(port, () =>
    console.log(`sample-expressjs app listening on port ${port}!`)
);

app.use(apiErrorHandler);
