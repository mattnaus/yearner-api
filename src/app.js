const express = require("express");
const shared = require("./shared/utils.js");
const fauna = require("faunadb");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const q = fauna.query;
const client = new fauna.Client({
    secret: process.env.FAUNA_SECRET,
});

app.get("/funds", async (req, res) => {
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
        for (fund of returnObjFaunaGetFunds.data) {
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

    res.send(funds);
});

app.get("/fund/:ref", async (req, res) => {
    const ref = req.params.ref;

    let returnObjFaunaGetHistory = [];
    try {
        returnObjFaunaGetHistory = await client.query(
            q.Map(
                q.Paginate(q.Match(q.Index("history_by_fund"), ref), {
                    size: 100000,
                }),
                q.Lambda("x", q.Select("data", q.Get(q.Var("x"))))
            )
        );
    } catch (error) {}

    res.send(returnObjFaunaGetHistory.data);
});

app.listen(port, () =>
    console.log(`sample-expressjs app listening on port ${port}!`)
);
