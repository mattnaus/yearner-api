const express = require("express");
const EthDater = require("ethereum-block-by-date");
const { createAlchemyWeb3 } = require("@alch/alchemy-web3");
const axios = require("axios");
const fauna = require("faunadb");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const web3 = createAlchemyWeb3(
    "https://eth-mainnet.alchemyapi.io/v2/***REMOVED***"
);

const q = fauna.query;
const client = new fauna.Client({
    secret: process.env.FAUNA_SECRET,
});

const dater = new EthDater(
    web3 // Web3 object, required.
);

const dateFormat = (d) => {
    let dString = d.getFullYear() + "-";
    if (d.getMonth() < 10) {
        dString += "0" + (d.getMonth() + 1);
    } else {
        dString += d.getMonth() + 1;
    }
    dString += "-";
    if (d.getDate() < 10) dString += "0" + d.getDate();
    else dString += d.getDate();

    return dString;
};

const round2Dec = (num) => {
    return Math.round((num + Number.EPSILON) * 100) / 100;
};

app.get("/update", async (req, res) => {
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

    if (returnObjFaunaGetFunds.data.length !== 0) {
        for (let fund of returnObjFaunaGetFunds.data) {
            console.log(
                "-- Processing contract " +
                    fund.data.name +
                    " (" +
                    fund.data.contract +
                    ")"
            );

            let contractABI = "";

            // If there's no ABI stored for this contract, let's sort that out
            if (!fund.data.hasOwnProperty("ABI")) {
                console.log("-- No ABI stored for contract, fixing...");
                let returnObj = await axios({
                    method: "get",
                    url: "https://api.etherscan.io/api",
                    params: {
                        module: "contract",
                        action: "getabi",
                        address: fund.data.contract,
                        apikey: "***REMOVED***",
                    },
                });

                contractABI = JSON.parse(returnObj.data.result);

                try {
                    let returnObjSaveABI = await client.query(
                        q.Update(fund.ref, {
                            data: {
                                ABI: contractABI,
                            },
                        })
                    );
                } catch (error) {}
            } else {
                console.log("-- Using stored ABI for contract.");
                contractABI = fund.data.ABI;
            }

            const instance = new web3.eth.Contract(
                contractABI,
                fund.data.contract
            );

            // if there's no activation data, let's sort that out
            let block;
            if (!fund.data.hasOwnProperty("activationStamp")) {
                console.log(
                    "-- no activation data, pulling from chain and saving... "
                );
                const activation = await instance.methods.activation().call();
                const date = new Date(activation * 1000);

                block = await dater.getDate(date, true);

                try {
                    let returnObjSaveActivation = await client.query(
                        q.Update(fund.ref, {
                            data: {
                                activationStamp: activation,
                                activationBlock: block,
                            },
                        })
                    );
                } catch (error) {}
            } else {
                console.log("-- activation data present, using saved data.");
                block = fund.data.activationBlock;
            }

            const perShare = await instance.methods
                .pricePerShare()
                .call(undefined, block.block);

            let today = new Date();
            let d = new Date(block.timestamp * 1000);
            if (fund.data.hasOwnProperty("lastUpdate")) {
                let dateSplit = fund.data.lastUpdate.split("-");

                d = new Date(
                    Date.UTC(
                        Number(dateSplit[0]),
                        Number(dateSplit[1] - 1),
                        Number(dateSplit[2]) + 1
                    )
                );
                console.log("-- picking up at date: " + d, dateSplit);
            }
            let dates = [];

            // loop from d until today
            for (d; d <= today; d.setDate(d.getDate() + 1)) {
                let block = await dater.getDate(d, true);
                let perShare = await instance.methods
                    .pricePerShare()
                    .call(undefined, block.block);

                let dString = dateFormat(d);

                let perShareEth = web3.utils.fromWei(perShare, "ether");
                console.log("-- " + dString, block.block, perShareEth);

                // add entry to database
                let returnObjFaunaAddHistory;
                try {
                    returnObjFaunaAddHistory = await client.query(
                        q.Call(q.Function("UpdateHistory"), [
                            fund.ref.id,
                            fund.data.name,
                            fund.data.contract,
                            dString,
                            perShareEth,
                        ])
                    );
                } catch (error) {
                    console.log(error);
                }
            }

            // set statistics: all time, 1y, 3m, 1m, 1w
            console.log("-- calculate some statistics...");

            // all time
            let returnObjFaunaGetToday;
            try {
                returnObjFaunaGetToday = await client.query(
                    q.Map(
                        q.Paginate(
                            q.Match(q.Index("history_by_fund_date"), [
                                fund.data.contract,
                                dateFormat(today),
                            ])
                        ),
                        q.Lambda("x", q.Get(q.Var("x")))
                    )
                );
            } catch (err) {
                console.log(err);
            }

            let valueToday = Number(returnObjFaunaGetToday.data[0].data.value);

            let difference = valueToday - 1;
            let percAll = (difference / 1) * 100;

            console.log("-- all time: " + round2Dec(percAll) + "%");

            // 1 year
            const activationDate = new Date(fund.data.activationBlock.date);
            const diffTime = Math.abs(today - activationDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            let perc1Year;
            if (diffDays > 365) {
                // if activation was more than 365 days ago, calculate
            } else {
                // if not, then 1 year matches all time
                perc1Year = percAll;
            }

            console.log("-- 1 year: " + round2Dec(perc1Year) + "%");

            console.log(
                "-- Done with " +
                    fund.data.name +
                    " (" +
                    fund.data.contract +
                    ")"
            );
            console.log("------------");
        }
    }

    res.send("Hello World!");
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
