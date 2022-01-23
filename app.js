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
const contract = "0x25212Df29073FfFA7A67399AcEfC2dd75a831A1A";

const q = fauna.query;
const client = new fauna.Client({
    secret: process.env.FAUNA_SECRET,
});

const dater = new EthDater(
    web3 // Web3 object, required.
);

app.get("/", async (req, res) => {
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
                "Processing contract " +
                    fund.data.name +
                    " (" +
                    fund.data.contract +
                    ")"
            );

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

            let contractABI = JSON.parse(returnObj.data.result);

            const instance = new web3.eth.Contract(contractABI, contract);

            const activation = await instance.methods.activation().call();
            const date = new Date(activation * 1000);

            let block = await dater.getDate(date, true);

            console.log(block);

            const perShare = await instance.methods
                .pricePerShare()
                .call(undefined, block.block);

            console.log(perShare);

            let today = new Date();
            let d = new Date(block.timestamp * 1000);
            if (fund.data.hasOwnProperty("lastUpdate")) {
                d = new Date(2022, 0, 10);
            }
            let dates = [];

            for (d; d <= today; d.setDate(d.getDate() + 1)) {
                let block = await dater.getDate(d, true);
                let perShare = await instance.methods
                    .pricePerShare()
                    .call(undefined, block.block);

                // date handling
                let dString = d.getFullYear() + "-";
                if (d.getMonth() < 10) dString += "0" + d.getMonth();
                else dString += d.getMonth();
                dString += "-";
                if (d.getDate() < 10) dString += "0" + d.getDate();
                else dString += d.getDate();
                console.log(dString, web3.utils.fromWei(perShare, "ether"));
            }

            console.log(
                "Done with " + fund.data.name + " (" + fund.data.contract + ")"
            );
            console.log("------------");
        }
    }

    res.send("Hello World!");
});

app.listen(port, () =>
    console.log(`sample-expressjs app listening on port ${port}!`)
);
