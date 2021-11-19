const express = require('express')
const EthDater = require('ethereum-block-by-date')
const { createAlchemyWeb3 } = require("@alch/alchemy-web3")
const axios = require("axios")

const app = express()
const port = process.env.PORT || 3000

const web3 = createAlchemyWeb3("https://eth-mainnet.alchemyapi.io/v2/***REMOVED***");
const contract = "0x25212Df29073FfFA7A67399AcEfC2dd75a831A1A";

const dater = new EthDater(
    web3 // Web3 object, required.
);

app.get('/', async (req, res) => {
    let returnObj = await axios({
        method: "get",
        url: "https://api.etherscan.io/api",
        params: {
            module: "contract",
            action: "getabi",
            address: contract,
            apikey: '***REMOVED***'
        }
    });
      
    let contractABI = JSON.parse(returnObj.data.result);

    const instance = new web3.eth.Contract(
        contractABI,
        contract
    );

    const activation = await instance.methods.activation().call();
    const date = new Date(activation * 1000);

    let block = await dater.getDate(date, true);

    console.log(block);

    const perShare = await instance.methods.pricePerShare().call(undefined, block.block);

    console.log(perShare);

    let today = new Date();
    let d = new Date(block.timestamp * 1000);
    let dates = [];

    for(d; d <= today; d.setDate(d.getDate()+1)) {
        let block = await dater.getDate(d, true);
        let perShare = await instance.methods.pricePerShare().call(undefined, block.block);
        console.log(perShare);
    }
      
    res.send('Hello World!')
})

app.listen(port, () => console.log(`sample-expressjs app listening on port ${port}!`))