module.exports.dateFormat = (d) => {
    let dString = d.getFullYear() + "-";
    if (d.getMonth() < 9) {
        dString += "0" + (d.getMonth() + 1);
    } else {
        dString += d.getMonth() + 1;
    }
    dString += "-";
    if (d.getDate() < 10) dString += "0" + d.getDate();
    else dString += d.getDate();

    return dString;
};

module.exports.round2Dec = (num) => {
    return Math.round((num + Number.EPSILON) * 100) / 100;
};
