/* 
 *  Copyright 2016 Waverley Labs, LLC
 *  
 *  This file is part of SDPcontroller
 *  
 *  SDPcontroller is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *  
 *  SDPcontroller is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *  
 *  You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */


// Load the libraries
var tls    = require('tls');
var http   = require('http');
var https  = require('https');
var fs     = require('fs');
var mysql  = require("mysql");
var credentialMaker = require('./sdpCredentialMaker');
var prompt = require("prompt");
var saml2 = require('saml2-js');
const { execSync } = require('child_process');

// If the user specified the config path, get it
if(process.argv.length > 2) {
    try {
        var config = require(process.argv[2]);
    } catch (e) {
        // It isn't accessible
        console.log("Did not find specified config file. Exiting");
        process.exit();
    }
} else {
    var config = require('./config.js');
}

const MSG_SIZE_FIELD_LEN = 4;

const encryptionKeyLenMin = 64;
const encryptionKeyLenMax = 256;
const hmacKeyLenMin = 64;
const hmacKeyLenMax = 256;

// a couple global variables
var db;
var dbPassword = config.dbPassword;
var serverKeyPassword = config.serverKeyPassword;
var myCredentialMaker = new credentialMaker(config);
var connectedGateways = [];
var connectedClients  = [];
var nextConnectionId  = 1;
var checkDatabaseTries = 0;
var checkOpenConnectionsTries = 0;
var lastDatabaseCheck = new Date();
var lastConnectionCheck = new Date();
var federatedControllers = [];
var fleetToken = "";
var fleetQueryId = "";

// check a couple config settings
if(config.encryptionKeyLen < encryptionKeyLenMin
   || config.encryptionKeyLen > encryptionKeyLenMax)
{
    var explanation = "Range is " + encryptionKeyLenMin + " to " + encryptionKeyLenMax;
    throw new sdpConfigException("encryptionKeyLen", explanation);
}

if(config.hmacKeyLen < hmacKeyLenMin
   || config.hmacKeyLen > hmacKeyLenMax)
{
    var explanation = "Range is " + hmacKeyLenMin + " to " + hmacKeyLenMax
    throw new sdpConfigException("hmacKeyLen", explanation);
}

// Preparing controller as SP
if(config.hasOwnProperty("useIdP") && config.useIdP) {
    var sp_options = {
        entity_id: config.entityId,
        private_key: fs.readFileSync(config.spKey).toString(),
        certificate: fs.readFileSync(config.spCert).toString(),
        assert_endpoint: config.callback,
        sign_get_request: true,
        allow_unencrypted_assertion: true
    };
    var sp = new saml2.ServiceProvider(sp_options);
    
    var idp_options = {
        sso_login_url: `${config.idpService}${config.idpEndpoint}`,
        sso_logout_url: `${config.idpService}${config.idpEndpoint}`,
        certificates: fs.readFileSync(config.idpCert).toString()
    };
    var idp = new saml2.IdentityProvider(idp_options);
}

// Getting information from Fleet
if(config.hasOwnProperty("useFleet") && config.useFleet) {
    fleetToken = fs.readFileSync(config.fleetTokenFile).toString().trim();
    function fleetQuery(path, method, data, cb) {
        var postData = JSON.stringify(data);
        var answer = "";

        var options = {
            ca: [ fs.readFileSync(config.caCert) ],
            port: config.fleetPort,
            hostname: config.fleetHostname,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + fleetToken
            }
        };

        var fleetConnectError = function(error) {
            console.error("Error connecting to Fleet: " + error);
        };

        var req = https.request(options, (res) => {
            if(res.statusCode != 200) {
                fleetConnectError("Status code " + res.statusCode);
                return;
            }
            res.on('data', (chunk) => {
                answer += chunk;
            });
            res.on('end', () => {
                try {
                    var answer_json = JSON.parse(answer);
                    if(config.debug)
                        console.log("Answer from Fleet: " + answer);
                    cb(answer_json);
                } catch (err) {
                    fleetConnectError(err);
                }
            });
        });

        req.on('error', fleetConnectError);

        if(config.debug)
            console.log("Sending " + method + " query to Fleet at: " + path);

        if(method == "POST") {
            if(config.debug)
                console.log("Sending " + postData);
            req.write(postData);
        }
        req.end();
    };
    fleetQuery("/api/v1/fleet/queries?query=" + config.fleetQuery, 'GET', {}, (answer) => {
        fleetQueryId = answer["queries"][0]["id"];
        if(config.debug)
            console.log("Found Query ID: " + fleetQueryId);
    });
}

myCredentialMaker.init(startController);

function startController() {
    if(serverKeyPassword || !config.serverKeyPasswordRequired)
        checkDbPassword();
    else
    {
        var schema = {
            properties: {
                password: {
                    description: 'Enter server key password',
                    hidden: true,
                    replace: '*',
                    required: true
                }
            }
        };
        
        prompt.start();
        
        prompt.get(schema, function(err,result) {
            if(err)
            {
                throw err;
            }
            else
            {
                serverKeyPassword = result.password;
                checkDbPassword();
            }    
        });
    }
}

function checkDbPassword() {
    if(dbPassword || !config.dbPasswordRequired)
        startDbPool();
    else
    {
        var schema = {
            properties: {
                password: {
                    description: 'Enter database password',
                    hidden: true,
                    replace: '*',
                    required: true
                }
            }
        };
        
        prompt.start();
        
        prompt.get(schema, function(err,result) {
            if(err)
                console.log(err);
            else
            {
                dbPassword = result.password;
                startDbPool();
            }    
        });
    }
}

function startDbPool() {
    // set up database pool
    if(config.dbPasswordRequired == false) {
        db = mysql.createPool({
          connectionLimit: config.maxConnections,
          host: config.dbHost,
          user: config.dbUser,
          database: config.dbName,
          debug: false
        });
    } else {
        db = mysql.createPool({
          connectionLimit: config.maxConnections,
          host: config.dbHost,
          user: config.dbUser,
          password: dbPassword, //config.dbPassword,
          database: config.dbName,
          debug: false
        });
    }
    
    startServer();
}


function startServer() {

    cleanOpenConnectionTable();
    getFederatedControllers();
    
    setTimeout(checkDatabaseForUpdates, 
               config.databaseMonitorInterval, 
               config.databaseMonitorInterval);
    
    // tls server options
    const options = {
        // the server's private key
        key: fs.readFileSync(config.serverKey),
        passphrase: serverKeyPassword,
        
        // the server's public cert
        cert: fs.readFileSync(config.serverCert),
        
        // require client certs
        requestCert: true,
        rejectUnauthorized: true,
        
        // for client certs created by us
        ca: [ fs.readFileSync(config.caCert) ]
    };
    
    
    // Start a TLS Server
    var server = tls.createServer(options, function (socket) {
    
        if(config.debug)
          console.log("Socket connection started");
        
        var action = null;
        var memberDetails = null;
        var dataTransmitTries = 0;
        var credentialMakerTries = 0;
        var databaseConnTries = 0;
        var badMessagesReceived = 0;
        var newKeys = null;
        var accessRefreshDue = false;
        var connectionId = nextConnectionId;
        var expectedMessageSize = 0;
        var totalSizeBytesReceived = 0;
        var sizeBytesNeeded = 0;
        var dataBytesToRead = 0;
        var totalMessageBytesReceived = 0;
        var sizeBuffer = Buffer.allocUnsafe(MSG_SIZE_FIELD_LEN);
        var messageBuffer = Buffer.allocUnsafe(0);

        if(Number.MAX_SAFE_INTEGER == connectionId)   // 9007199254740991
            nextConnectionId = 1;
        else
            nextConnectionId += 1;
        
        // Identify the connecting client or gateway
        var sdpId = parseInt(socket.getPeerCertificate().subject.CN);
        
        console.log("Connection from SDP ID " + sdpId + ", connection ID " + connectionId);
        
        // Set the socket timeout to watch for inactivity
        if(config.socketTimeout) 
            socket.setTimeout(config.socketTimeout, function() {
                console.error("Connection to SDP ID " + sdpId + ", connection ID " + connectionId + " has timed out. Disconnecting.");
                //if(memberDetails.type === 'gateway') {
                //    removeOpenConnections(connectionId);
                //}
                //removeFromConnectionList(memberDetails, connectionId);
            });
        
        // Handle incoming requests from members
        socket.on('data', function (data) {
            while(data.length) {
                // have we set the full message size variable yet
                if(expectedMessageSize == 0) {
                    sizeBytesNeeded = MSG_SIZE_FIELD_LEN - totalSizeBytesReceived;

                    // exceptional case, so few bytes arrived
                    // not enough data to read expected message size
                    if( data.length < sizeBytesNeeded ) {
                        data.copy(sizeBuffer, totalSizeBytesReceived, 0, data.length);
                        totalSizeBytesReceived += data.length;
                        data = Buffer.allocUnsafe(0);
                        return;
                    }
                    
                    data.copy(sizeBuffer, totalSizeBytesReceived, 0, sizeBytesNeeded);
                    totalSizeBytesReceived = MSG_SIZE_FIELD_LEN;
                    expectedMessageSize = sizeBuffer.readUInt32BE(0);

                    // time to reset the buffer
                    messageBuffer = Buffer.allocUnsafe(0);
                }

                // if there's more data in the received buffer besides the message size field (i.e. actual message contents)
                if( data.length > sizeBytesNeeded ) {

                    // if there are fewer bytes than what's needed to complete the message
                    if( (data.length - sizeBytesNeeded) < (expectedMessageSize - totalMessageBytesReceived) ){
                        // then read from after the size field to end of the received buffer
                        dataBytesToRead = data.length - sizeBytesNeeded;
                    }
                    else {
                        dataBytesToRead = expectedMessageSize - totalMessageBytesReceived;
                    }
                    
                    totalMessageBytesReceived += dataBytesToRead;
                    messageBuffer = Buffer.concat([messageBuffer, 
                        data.slice(sizeBytesNeeded, sizeBytesNeeded+dataBytesToRead)],
                        totalMessageBytesReceived);
                }

                // if the message is now complete, process
                if(totalMessageBytesReceived == expectedMessageSize) {
                    expectedMessageSize = 0;
                    totalSizeBytesReceived = 0;
                    totalMessageBytesReceived = 0;
                    processMessage(messageBuffer);
                }

                data = data.slice(sizeBytesNeeded+dataBytesToRead);
                sizeBytesNeeded = 0;
                dataBytesToRead = 0;

            }
        });
        
        socket.on('end', function () {
            console.log("Connection to SDP ID " + sdpId + ", connection ID " + connectionId + " closed.");
            if(memberDetails.type === 'gateway') {
                removeOpenConnections(connectionId);
            }
            removeFromConnectionList(memberDetails, connectionId);
        });
        
        socket.on('error', function (error) {
            console.error(error);
            if(memberDetails.type === 'gateway') {
                removeOpenConnections(connectionId);
            }
            removeFromConnectionList(memberDetails, connectionId);
            socket.end();
        });
        
        // Find sdpId in the database
        db.getConnection(function(error,connection){
            if(error){
                console.error("Error connecting to database: " + error);
                writeToSocket(socket, JSON.stringify({action: 'database_error'}), true);
                return;
            }
            
            var databaseErrorCallback = function(error) {
                connection.removeListener('error', databaseErrorCallback);
                connection.release();
                console.error("Error from database connection: " + error);
                return;
            };
            
            connection.on('error', databaseErrorCallback);
            
            connection.query('SELECT * FROM `sdpid` WHERE `sdpid` = ?', [sdpId], 
            function (error, rows, fields) {
                connection.removeListener('error', databaseErrorCallback);
                connection.release();
                if (error) {
                    console.error("Query returned error: " + error);
                    console.error(error);
                    writeToSocket(socket, JSON.stringify({action: 'database_error'}), true);
                } else if (rows.length < 1) {
                    console.error("SDP ID not found, notifying and disconnecting");
                    writeToSocket(socket, JSON.stringify({action: 'unknown_sdp_id'}), true);
                } else if (rows.length > 1) {
                    console.error("Query returned multiple rows for SDP ID: " + sdpId);
                    writeToSocket(socket, JSON.stringify({action: 'database_error'}), true);
                } else if (rows[0].valid == 0) {
                    console.error("SDP ID " + sdpId+" disabled. Disconnecting.");
                    writeToSocket(socket, JSON.stringify({action: 'sdpid_unauthorized'}), true);
                } else {
                
                    memberDetails = rows[0];
                    
                    // add the connection to the appropriate list
                    var destList;
                    if(memberDetails.type === 'gateway') {
                        destList = connectedGateways;
                    } else {
                        destList = connectedClients;
                    }
                    
                    // first ensure no duplicate connection entries are left around
                    for(var idx = 0; idx < destList.length; idx++) {
                        if(destList[idx].sdpId == memberDetails.sdpid) {
                            // this next call triggers socket.on('end'...
                            // which removes the entry from the connection list
                            writeToSocket(destList[idx].socket,
                                JSON.stringify({action: 'duplicate_connection'}),
                                true
                            );
                            
                            // the check above means there should never be more than 1 match
                            // and letting the loop keep checking introduces race condition
                            // because the .end callback also loops through the list
                            // and will delete one list entry
                            break;
                        }
                    }
                    
                    // now add the connection to the right list
                    newEntry = {
                        sdpId: memberDetails.sdpid,
                        connectionId: connectionId,
                        connectionTime: new Date(),
                        socket
                    };
                    
                    //if(memberDetails.type === 'gateway') {
                    //    newEntry.connections = null;
                    //}
                    
                    destList.push(newEntry);
                    
                    
                    if (config.debug) {
                        console.log("Connected gateways: \n", connectedGateways, "\n");
                        console.log("Connected clients: \n", connectedClients, "\n");
                        console.log("Data for client is: ");
                        console.log(memberDetails);
                    }
                    
                    // possibly send credential update
                    var now = new Date();
                    if(now > memberDetails.cred_update_due) {
                        handleCredentialUpdate();
                    } else {
                        writeToSocket(socket, JSON.stringify({action: 'credentials_good'}), false);
                    }
                  
                }  
            
            });
          
        });
    
        
        // Parse SDP messages 
        function processMessage(data) {
            if(config.debug) {
                console.log("Message Data Received: ");
                console.log(data.toString());
            }
            
            // Ignore message if not yet ready
            // Clients are not supposed to send the first message
            if(!memberDetails){
                console.log("Ignoring premature message.");
                return;
            }
            
            try {
                var message = JSON.parse(data);
            }
            catch (err) {
                console.error("Error processing the following received data: \n" + data.toString());
                console.error("JSON parse failed with error: " + err);
                handleBadMessage(data.toString());
                return;
            }
            
            if(config.debug) {
                console.log("Message parsed");
                console.log("Message received from SDP ID " + memberDetails.sdpid);
                console.log("JSON-Parsed Message Data Received: ");
                for(var myKey in message) {
                    console.log("key: " + myKey + "   value: " + message[myKey]);
                }
            }
            
            
            action = message['action'];
            if (action === 'credential_update_request') {
                handleCredentialUpdate();
            } else if (action === 'credential_update_ack')  {
                handleCredentialUpdateAck();
            } else if (action === 'keep_alive') {
                handleKeepAlive();
            } else if (action === 'service_refresh_request') {
                handleServiceRefresh();
            } else if (action === 'service_ack') {
                handleServiceAck();
            } else if (action === 'access_refresh_request') {
                handleAccessRefresh();
            } else if (action === 'access_update_request') {
                handleAccessUpdate(message);
            } else if (action === 'access_ack') {
                handleAccessAck();
            } else if (action === 'service_list_request') {
                handleServiceList(message);
            } else if (action === 'federated_service_list_request') {
                handleFederatedServiceList(message);
            } else if (action === 'send_spa_federated') {
                handleFederatedSPA(message);
            } else if (action === 'remote_attestation') {
                handleRemoteAttestation(message);
            } else if (action === 'connection_update') {
                handleConnectionUpdate(message);
            } else if (action === 'bad_message') {
                // doing nothing with these yet
                return;
            } else {
                console.error("Invalid message received, invalid or missing action");
                handleBadMessage(data.toString());
            }
        }    
        
        function handleKeepAlive() {
            if (config.debug) {
                console.log("Received keep_alive from SDP ID "+memberDetails.sdpid+", responding now.");
            }
            
            var keepAliveMessage = {
                action: 'keep_alive'
            };
            
            // For testing only, send a bunch of copies fast
            if (config.testManyMessages > 0) {
                console.log("Sending " +config.testManyMessages+ " extra messages first for testing rather than just 1");
                var jsonMsgString = JSON.stringify(keepAliveMessage);
                for(var ii = 0; ii < config.testManyMessages; ii++) {
                    writeToSocket(socket, jsonMsgString, false);
                }
            }
            
            writeToSocket(socket, JSON.stringify(keepAliveMessage), false);
            //console.log("keepAlive message written to socket");
        
        }
    
    
        function handleCredentialUpdate() {
            if (dataTransmitTries >= config.maxDataTransmitTries) {
                // Data transmission has failed
                console.error("Data transmission to SDP ID " + memberDetails.sdpid + 
                    " has failed after " + (dataTransmitTries+1) + " attempts");
                console.error("Closing connection");
                socket.end();
                return;
            }
            
            // get the credentials
            myCredentialMaker.getNewCredentials(memberDetails, function(err, data){
                if (err) {
                  
                    credentialMakerTries++;
                    
                    if (credentialMakerTries >= config.maxCredentialMakerTries) {
                        // Credential making has failed
                        console.error("Failed to make credentials for SDP ID " + memberDetails.sdpid +
                                  " " + credentialMakerTries + " times.");
                        console.error("Closing connection");
                        
                        var credErrMessage = {
                            action: 'credential_update_error',
                            data: 'Failed to generate credentials '+credentialMakerTries+ 
                                ' times. Disconnecting.'
                        };
                        
                        writeToSocket(socket, JSON.stringify(credErrMessage), true);
                        return;
                    }
                    
                    // otherwise, just notify requestor of error
                    var credErrMessage = {
                        action: 'credential_update_error',
                        data: 'Could not generate new credentials',
                    };
                
                
                    console.log("Sending credential_update_error message to SDP ID " + 
                        memberDetails.sdpid + ", failed attempt: " + credentialMakerTries);
                    writeToSocket(socket, JSON.stringify(credErrMessage), false);
                
                } else {
                    // got credentials, send them over
                    var newCredMessage = {
                        action: 'credential_update',
                        data
                    };
                    
                    var updated = new Date();
                    var expires = new Date();
                    expires.setDate(expires.getDate() + config.daysToExpiration);
                    expires.setHours(0);
                    expires.setMinutes(0);
                    expires.setSeconds(0);
                    expires.setMilliseconds(0);
                    
                    newKeys = {
                        spa_encryption_key_base64: data.spa_encryption_key_base64,
                        spa_hmac_key_base64: data.spa_hmac_key_base64,
                        updated,
                        expires
                    };
                    
                    console.log("Sending credential_update message to SDP ID " + memberDetails.sdpid + ", attempt: " + dataTransmitTries);
                    dataTransmitTries++;
                    writeToSocket(socket, JSON.stringify(newCredMessage), false);
                
                }
            
            });
        } // END FUNCTION handleCredentialUpdate
      
      
        function handleCredentialUpdateAck()  {
            console.log("Received credential update acknowledgement from SDP ID "+memberDetails.sdpid+
                ", data successfully delivered");
            
            // store the necessary info in the database
            storeKeysInDatabase();
        
        }  // END FUNCTION handleCredentialUpdateAck
    
    
        function notifyGateways() {
            // get database connection
            db.getConnection(function(error,connection){
                if(error){
                    console.error("Error connecting to database in preparation " + 
                                  "to notify gateways of a client's credential update: " + error);
                    
                    // notify the requestor of our database troubles
                    writeToSocket(socket, 
                        JSON.stringify({
                            action: 'notify_gateways_error',
                            data: 'Database unreachable. Gateways not notified of credential update.'
                        }), 
                        false
                    );
                    
                    return;
                }
                
                var databaseErrorCallback = function(error) {
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    console.error("Error from database connection: " + error);
                    return;
                };
        
                connection.on('error', databaseErrorCallback);
                
                // this next query requires a simple array of only
                // the sdp ids listed in connectedGateways
                var gatewaySdpIdList = [];
                for(var idx = 0; idx < connectedGateways.length; idx++) {
                    gatewaySdpIdList.push(connectedGateways[idx].sdpId);
                }
                
                if(gatewaySdpIdList.length < 1)
                {
                    console.log("No relevant gateways to notify regarding credential update to SDP ID "+memberDetails.sdpid);
                    return;
                }
                
                if(config.allowLegacyAccessRequests)
                {
                    connection.query(
                        '(SELECT ' +
                        '    `service_gateway`.`gateway_sdpid`,  ' +
                        '    `service_gateway`.`service_id`, ' +
                        '    `service_gateway`.`protocol`, ' +
                        '    `service_gateway`.`port`, ' +
                        '    `sdpid`.`encrypt_key`,  ' +
                        '    `sdpid`.`hmac_key` ' +
                        'FROM `service_gateway` ' +
                        '    JOIN `sdpid_service` ' +
                        '        ON `sdpid_service`.`service_id` = `service_gateway`.`service_id` ' +
                        '    JOIN `sdpid` ' +
                        '        ON `sdpid`.`sdpid` = `sdpid_service`.`sdpid` ' +
                        'WHERE ' +
                        '    `service_gateway`.`gateway_sdpid` IN (?) AND ' +
                        '    `sdpid`.`sdpid` = ? )' +
                        'UNION ' +
                        '(SELECT ' +
                        '    `service_gateway`.`gateway_sdpid`, ' +
                        '    `group_service`.`service_id`,  ' +
                        '    `service_gateway`.`protocol`, ' +
                        '    `service_gateway`.`port`, ' +
                        '    `sdpid`.`encrypt_key`,  ' +
                        '    `sdpid`.`hmac_key` ' +
                        'FROM `service_gateway` ' +
                        '    JOIN `group_service` ' +
                        '        ON `group_service`.`service_id` = `service_gateway`.`service_id` ' +
                        '    JOIN `group` ' +
                        '        ON `group`.`id` = `group_service`.`group_id` ' +
                        '    JOIN `user_group` ' +
                        '        ON `user_group`.`group_id` = `group`.`id` ' +
                        '    JOIN `sdpid` ' +
                        '        ON `sdpid`.`user_id` = `user_group`.`user_id` ' +
                        'WHERE ' +
                        '    `service_gateway`.`gateway_sdpid` IN (?) AND ' +
                        '    `sdpid`.`sdpid` = ? AND ' +
                        '    `group`.`valid` = 1 )' +
                        'ORDER BY `gateway_sdpid` ',
                        [gatewaySdpIdList, 
                         memberDetails.sdpid, 
                         gatewaySdpIdList, 
                         memberDetails.sdpid],
                        function (error, rows, fields) {
                            connection.removeListener('error', databaseErrorCallback);
                            connection.release();
                            if(error) {
                                console.error("Access data query returned error: " + error);
                                writeToSocket(socket, 
                                    JSON.stringify({
                                        action: 'notify_gateways_error',
                                        data: 'Database error. Gateways not notified of credential update.'
                                    }), 
                                    false
                                );
                                return;
                            }
                            
                            if(rows.length == 0) {
                                console.log("No relevant gateways to notify regarding credential update to SDP ID "+memberDetails.sdpid);
                                return;
                            }
                            
                            var thisRow = rows[0];
                            var currentGatewaySdpId = thisRow.gateway_sdpid;
                            var open_ports = thisRow.protocol + "/" + thisRow.port;
                            var service_list = thisRow.service_id.toString();
                            var encryptKey = thisRow.encrypt_key;
                            var hmacKey = thisRow.hmac_key;
                            
                            for(var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                                thisRow = rows[rowIdx];
                                
                                if(thisRow.gateway_sdpid != currentGatewaySdpId) {
                                    currentGatewaySdpId = thisRow.gateway_sdpid;
                                    service_list = thisRow.service_id.toString();
                                    open_ports = thisRow.protocol + "/" + thisRow.port;
                                    encryptKey = thisRow.encrypt_key;
                                    hmacKey = thisRow.hmac_key;
                                } else if(rowIdx != 0) {
                                    service_list += ", " + thisRow.service_id.toString();
                                    open_ports += ", " + thisRow.protocol + "/" + thisRow.port;
                                }
                                
                                // if this is the last data row or the next is a different gateway
                                if( (rowIdx + 1) == rows.length || 
                                    rows[rowIdx + 1].gateway_sdpid != currentGatewaySdpId ) {
                                    
                                    // send off this stanza data
                                    notifyGateway(currentGatewaySdpId, 
                                                  memberDetails.sdpid,
                                                  service_list, 
                                                  open_ports,
                                                  encryptKey,
                                                  hmacKey);
                                }
                            }
                            
                            // only after successful notification
                            if(memberDetails.type === 'client' &&
                               !config.keepClientsConnected) 
                            {
                                socket.end();
                            }
                    
            
                        } // END QUERY CALLBACK FUNCTION
            
                    );  // END QUERY DEFINITION
                    
                }  // END IF allowLegacyAccessRequests
                else
                {
                    connection.query(
                        '(SELECT ' +
                        '    `service_gateway`.`gateway_sdpid`,  ' +
                        '    `service_gateway`.`service_id`, ' +
                        '    `sdpid`.`encrypt_key`,  ' +
                        '    `sdpid`.`hmac_key` ' +
                        'FROM `service_gateway` ' +
                        '    JOIN `sdpid_service` ' +
                        '        ON `sdpid_service`.`service_id` = `service_gateway`.`service_id` ' +
                        '    JOIN `sdpid` ' +
                        '        ON `sdpid`.`sdpid` = `sdpid_service`.`sdpid` ' +
                        'WHERE ' +
                        '    `service_gateway`.`gateway_sdpid` IN (?) AND ' +
                        '    `sdpid`.`sdpid` = ? )' +
                        'UNION ' +
                        '(SELECT ' +
                        '    `service_gateway`.`gateway_sdpid`, ' +
                        '    `group_service`.`service_id`,  ' +
                        '    `sdpid`.`encrypt_key`,  ' +
                        '    `sdpid`.`hmac_key` ' +
                        'FROM `service_gateway` ' +
                        '    JOIN `group_service` ' +
                        '        ON `group_service`.`service_id` = `service_gateway`.`service_id` ' +
                        '    JOIN `group` ' +
                        '        ON `group`.`id` = `group_service`.`group_id` ' +
                        '    JOIN `user_group` ' +
                        '        ON `user_group`.`group_id` = `group`.`id` ' +
                        '    JOIN `sdpid` ' +
                        '        ON `sdpid`.`user_id` = `user_group`.`user_id` ' +
                        'WHERE ' +
                        '    `service_gateway`.`gateway_sdpid` IN (?) AND ' +
                        '    `sdpid`.`sdpid` = ? AND ' +
                        '    `group`.`valid` = 1 )' +
                        'ORDER BY `gateway_sdpid` ',
                        [gatewaySdpIdList, 
                         memberDetails.sdpid, 
                         gatewaySdpIdList, 
                         memberDetails.sdpid],
                        function (error, rows, fields) {
                            connection.removeListener('error', databaseErrorCallback);
                            connection.release();
                            if(error) {
                                console.error("Access data query returned error: " + error);
                                writeToSocket(socket, 
                                    JSON.stringify({
                                        action: 'notify_gateways_error',
                                        data: 'Database error. Gateways not notified of credential update.'
                                    }), 
                                    false
                                );
                                return;
                            }
                            
                            if(rows.length == 0) {
                                console.log("No relevant gateways to notify regarding credential update to SDP ID "+memberDetails.sdpid);
                                return;
                            }
                            
                            var thisRow = rows[0];
                            var currentGatewaySdpId = thisRow.gateway_sdpid;
                            var service_list = thisRow.service_id.toString();
                            var encryptKey = thisRow.encrypt_key;
                            var hmacKey = thisRow.hmac_key;
                            
                            for(var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                                thisRow = rows[rowIdx];
                                
                                if(thisRow.gateway_sdpid != currentGatewaySdpId) {
                                    currentGatewaySdpId = thisRow.gateway_sdpid;
                                    service_list = thisRow.service_id.toString();
                                    encryptKey = thisRow.encrypt_key;
                                    hmacKey = thisRow.hmac_key;
                                } else if(rowIdx != 0) {
                                    service_list += ", " + thisRow.service_id.toString();
                                }
                                
                                // if this is the last data row or the next is a different gateway
                                if( (rowIdx + 1) == rows.length || 
                                    rows[rowIdx + 1].gateway_sdpid != currentGatewaySdpId ) {
                                    
                                    // send off this stanza data
                                    notifyGateway(currentGatewaySdpId, 
                                                  memberDetails.sdpid,
                                                  service_list, 
                                                  null,
                                                  encryptKey,
                                                  hmacKey);
                                }
                            }
                            
                            // only after successful notification
                            if(memberDetails.type === 'client' &&
                               !config.keepClientsConnected) 
                            {
                                socket.end();
                            }
                    
            
                        } // END QUERY CALLBACK FUNCTION
            
                    );  // END QUERY DEFINITION
                                    
                }  // END ELSE (i.e. NOT allowLegacyAccessRequests)
              
            });  // END DATABASE CONNECTION CALLBACK
                    
        } // END FUNCTION notifyGateways
      
    
        function notifyGateway(gatewaySdpId, clientSdpId, service_list, open_ports, encKey, hmacKey) {
        
            var gatewaySocket = null;
            
            // get the right socket
            for(var idx = 0; idx < connectedGateways.length; idx++) {
                if(connectedGateways[idx].sdpId == gatewaySdpId) {
                    gatewaySocket = connectedGateways[idx].socket;
                    break;
                }
            }
            
            debugger;
            
            if(!gatewaySocket) {
                console.log("Attempted to notify gateway with SDP ID " +gatewaySdpId+
                            " of a client's updated credentials, but socket not found.");
                return;
            }
        
            if(open_ports)
            {
                var data = [{
                    sdp_id: clientSdpId,
                    source: "ANY",
                    service_list: service_list,
                    open_ports: open_ports,
                    spa_encryption_key_base64: encKey,
                    spa_hmac_key_base64: hmacKey
                }];
            }
            else
            {
                var data = [{
                    sdp_id: clientSdpId,
                    source: "ANY",
                    service_list: service_list,
                    spa_encryption_key_base64: encKey,
                    spa_hmac_key_base64: hmacKey
                }];
            }
            
            if(config.debug) {
                console.log("Access update data to send to "+gatewaySdpId+": \n", data);
            }
            
            console.log("Sending access_update message to SDP ID " + gatewaySdpId);
        
            writeToSocket(gatewaySocket,
                JSON.stringify({
                    action: 'access_update',
                    data
                }), 
                false
            );
            
            
        } // END FUNCTION notifyGateway
      
      
        function removeFromConnectionList(details, connectionId) {
            var theList = null;
            var found = false;
            
            if(details.type === 'client') {
                var theList = connectedClients;
                console.log("Searching connected client list for SDP ID " + details.sdpid + ", connection ID " + connectionId);
            } else {
                var theList = connectedGateways;
                console.log("Searching connected gateway list for SDP ID " + details.sdpid + ", connection ID " + connectionId);
            }
            
            for(var idx = 0; idx < theList.length; idx++) {
                if(theList[idx].connectionId == connectionId) {
                    theList.splice(idx, 1);
                    found = true;
                    break;
                }
            }
            
            if(found) {
                console.log("Found and removed SDP ID "+details.sdpid+ ", connection ID " + connectionId +" from connection list");
            } else {
                console.log("Did not find SDP ID "+details.sdpid+ ", connection ID " + connectionId +" in the connection list");
            }
        }
      
      
        function handleServiceRefresh() {
            if (dataTransmitTries >= config.maxDataTransmitTries) {
                // Data transmission has failed
                console.error("Data transmission to SDP ID " + memberDetails.sdpid + 
                  " has failed after " + (dataTransmitTries+1) + " attempts");
                console.error("Closing connection");
                socket.end();
                return;
            }
        
            db.getConnection(function(error,connection){
                if(error){
                    console.error("Error connecting to database: " + error);
                    
                    // notify the requestor of our database troubles
                    writeToSocket(socket, 
                        JSON.stringify({
                            action: 'service_refresh_error',
                            data: 'Database unreachable. Try again soon.'
                        }), 
                        false
                    );
                    
                    return;
                }
                
                var databaseErrorCallback = function(error) {
                  connection.removeListener('error', databaseErrorCallback);
                  connection.release();
                  console.error("Error from database connection: " + error);
                  return;
                };
        
                connection.on('error', databaseErrorCallback);
                
                connection.query(
                    'SELECT ' +
                    '    `service_gateway`.`protocol`,  ' +
                    '    `service_gateway`.`service_id`,  ' +
                    '    `service_gateway`.`port`, ' +
                    '    `service_gateway`.`nat_ip`, ' +
                    '    `service_gateway`.`nat_port` ' +
                    'FROM `service_gateway` ' +
                    'WHERE `service_gateway`.`gateway_sdpid` = ? ',
                    [memberDetails.sdpid],
                    function (error, rows, fields) {
                        connection.removeListener('error', databaseErrorCallback);
                        connection.release();
                        if(error) {
                            console.error("Service data query returned error: " + error);
                            writeToSocket(socket, 
                                JSON.stringify({
                                    action: 'service_refresh_error',
                                    data: 'Database error. Try again soon.'
                                }), 
                                false
                            );
                            return;
                        }
                        
                        var data = [];
                        for(var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                            var thisRow = rows[rowIdx];
                            data.push({
                                service_id: thisRow.service_id,
                                proto: thisRow.protocol,
                                port: thisRow.port,
                                nat_ip: thisRow.nat_ip,
                                nat_port: thisRow.nat_port,
                            });
                        }
                        
                        if(config.debug) {
                            console.log("Service refresh data to send: \n", data, "\n");
                        }
                        
                        dataTransmitTries++;
                        console.log("Sending service_refresh message to SDP ID " + 
                            memberDetails.sdpid + ", attempt: " + dataTransmitTries);
                
                        writeToSocket(socket, 
                            JSON.stringify({
                                action: 'service_refresh',
                                data
                            }), 
                            false
                        );
                        
                    } // END QUERY CALLBACK FUNCTION
        
                );  // END QUERY DEFINITION
          
            });  // END DATABASE CONNECTION CALLBACK
            
        }  // END FUNCTION handleServiceRefresh
      
      
        function handleServiceAck()  {
            console.log("Received service data acknowledgement from SDP ID "+memberDetails.sdpid+
                ", data successfully delivered");
            
            clearStateVars();
        
        }  // END FUNCTION handleServiceAck
    
    
      
        function handleAccessRefresh() {
            if (dataTransmitTries >= config.maxDataTransmitTries) {
                // Data transmission has failed
                console.error("Data transmission to SDP ID " + memberDetails.sdpid + 
                  " has failed after " + (dataTransmitTries+1) + " attempts");
                console.error("Closing connection");
                socket.end();
                return;
            }
        
            db.getConnection(function(error,connection){
                if(error){
                    console.error("Error connecting to database: " + error);
                    
                    // notify the requestor of our database troubles
                    writeToSocket(socket, 
                        JSON.stringify({
                            action: 'access_refresh_error',
                            data: 'Database unreachable. Try again soon.'
                        }), 
                        false
                    );
                    
                    return;
                }
                
                var databaseErrorCallback = function(error) {
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    console.error("Error from database connection: " + error);
                    return;
                };
        
                connection.on('error', databaseErrorCallback);
                
                if(config.allowLegacyAccessRequests) 
                {
                    connection.query(
                        '(SELECT ' +
                        '    `sdpid`.`sdpid`,  ' +
                        '    `sdpid_service`.`service_id`,  ' +
                        '    `service_gateway`.`protocol`,  ' +
                        '    `service_gateway`.`port`,  ' +
                        '    `sdpid`.`encrypt_key`,  ' +
                        '    `sdpid`.`hmac_key` ' +
                        'FROM `service_gateway` ' +
                        '    JOIN `sdpid_service` ' +
                        '        ON `sdpid_service`.`service_id` = `service_gateway`.`service_id` ' +
                        '    JOIN `sdpid` ' +
                        '        ON `sdpid`.`sdpid` = `sdpid_service`.`sdpid` ' +
                        'WHERE `sdpid`.`valid` = 1 AND `service_gateway`.`gateway_sdpid` = ? )' +
                        'UNION ' +
                        '(SELECT ' +
                        '    `sdpid`.`sdpid`,  ' +
                        '    `group_service`.`service_id`,  ' +
                        '    `service_gateway`.`protocol`,  ' +
                        '    `service_gateway`.`port`,  ' +
                        '    `sdpid`.`encrypt_key`,  ' +
                        '    `sdpid`.`hmac_key` ' +
                        'FROM `service_gateway` ' +
                        '    JOIN `group_service` ' +
                        '        ON `group_service`.`service_id` = `service_gateway`.`service_id` ' +
                        '    JOIN `group` ' +
                        '        ON `group`.`id` = `group_service`.`group_id` ' +
                        '    JOIN `user_group` ' +
                        '        ON `user_group`.`group_id` = `group`.`id` ' +
                        '    JOIN `sdpid` ' +
                        '        ON `sdpid`.`user_id` = `user_group`.`user_id` ' +
                        'WHERE ' +
                        '    `sdpid`.`valid` = 1 AND ' +
                        '    `group`.`valid` = 1 AND ' +
                        '    `service_gateway`.`gateway_sdpid` = ? )' +
                        'ORDER BY `sdpid` ',
                        [memberDetails.sdpid, memberDetails.sdpid],
                        function (error, rows, fields) {
                            connection.removeListener('error', databaseErrorCallback);
                            connection.release();
                            if(error) {
                                console.error("Access data query returned error: " + error);
                                writeToSocket(socket, 
                                    JSON.stringify({
                                        action: 'access_refresh_error',
                                        data: 'Database error. Try again soon.'
                                    }), 
                                    false
                                );
                                return;
                            }
                            
                            var data = [];
                            var dataIdx = 0;
                            var currentSdpId = 0;
                            for(var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                                var thisRow = rows[rowIdx];
                                dataIdx = data.length - 1;
                                if(thisRow.sdpid != currentSdpId) {
                                    currentSdpId = thisRow.sdpid;
                                    data.push({
                                        sdp_id: thisRow.sdpid,
                                        source: "ANY",
                                        service_list: thisRow.service_id.toString(),
                                        open_ports: thisRow.protocol + "/" +thisRow.port,
                                        spa_encryption_key_base64: thisRow.encrypt_key,
                                        spa_hmac_key_base64: thisRow.hmac_key
                                    });
                                } else {
                                    data[dataIdx].service_list += ", " + thisRow.service_id.toString();
                                    data[dataIdx].open_ports += ", " + thisRow.protocol + "/" +thisRow.port;
                                }
                            }
                            
                            if(config.debug) {
                                console.log("Access refresh data to send: \n", data, "\n");
                            }
                            
                            dataTransmitTries++;
                            console.log("Sending access_refresh message to SDP ID " + 
                                memberDetails.sdpid + ", attempt: " + dataTransmitTries);

                            writeToSocket(socket, 
                                JSON.stringify({
                                    action: 'access_refresh',
                                    data
                                }), 
                                false
                            );
                            
                        } // END QUERY CALLBACK FUNCTION
            
                    );  // END QUERY DEFINITION
                    
                } // END IF allowLegacyAccessRequests
                else
                {
                    connection.query(
                        '(SELECT ' +
                        '    `sdpid`.`sdpid`,  ' +
                        '    `sdpid_service`.`service_id`,  ' +
                        '    `sdpid`.`encrypt_key`,  ' +
                        '    `sdpid`.`hmac_key` ' +
                        'FROM `service_gateway` ' +
                        '    JOIN `sdpid_service` ' +
                        '        ON `sdpid_service`.`service_id` = `service_gateway`.`service_id` ' +
                        '    JOIN `sdpid` ' +
                        '        ON `sdpid`.`sdpid` = `sdpid_service`.`sdpid` ' +
                        'WHERE `sdpid`.`valid` = 1 AND `service_gateway`.`gateway_sdpid` = ? )' +
                        'UNION ' +
                        '(SELECT ' +
                        '    `sdpid`.`sdpid`,  ' +
                        '    `group_service`.`service_id`,  ' +
                        '    `sdpid`.`encrypt_key`,  ' +
                        '    `sdpid`.`hmac_key` ' +
                        'FROM `service_gateway` ' +
                        '    JOIN `group_service` ' +
                        '        ON `group_service`.`service_id` = `service_gateway`.`service_id` ' +
                        '    JOIN `group` ' +
                        '        ON `group`.`id` = `group_service`.`group_id` ' +
                        '    JOIN `user_group` ' +
                        '        ON `user_group`.`group_id` = `group`.`id` ' +
                        '    JOIN `sdpid` ' +
                        '        ON `sdpid`.`user_id` = `user_group`.`user_id` ' +
                        'WHERE ' +
                        '    `sdpid`.`valid` = 1 AND ' +
                        '    `group`.`valid` = 1 AND ' +
                        '    `service_gateway`.`gateway_sdpid` = ? )' +
                        'ORDER BY `sdpid` ',
                        [memberDetails.sdpid, memberDetails.sdpid],
                        function (error, rows, fields) {
                            connection.removeListener('error', databaseErrorCallback);
                            connection.release();
                            if(error) {
                                console.error("Access data query returned error: " + error);
                                writeToSocket(socket, 
                                    JSON.stringify({
                                        action: 'access_refresh_error',
                                        data: 'Database error. Try again soon.'
                                    }), 
                                    false
                                );
                                return;
                            }
                            
                            var data = [];
                            var dataIdx = 0;
                            var currentSdpId = 0;
                            for(var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                                var thisRow = rows[rowIdx];
                                dataIdx = data.length - 1;
                                if(thisRow.sdpid != currentSdpId) {
                                    currentSdpId = thisRow.sdpid;
                                    data.push({
                                        sdp_id: thisRow.sdpid,
                                        source: "ANY",
                                        service_list: thisRow.service_id.toString(),
                                        spa_encryption_key_base64: thisRow.encrypt_key,
                                        spa_hmac_key_base64: thisRow.hmac_key
                                    });
                                } else {
                                    data[dataIdx].service_list += ", " + thisRow.service_id.toString();
                                }
                            }
                            
                            if(config.debug) {
                                console.log("Access refresh data to send: \n", data, "\n");
                            }
                            
                            dataTransmitTries++;
                            console.log("Sending access_refresh message to SDP ID " + 
                                memberDetails.sdpid + ", attempt: " + dataTransmitTries);
                    
                            writeToSocket(socket, 
                                JSON.stringify({
                                    action: 'access_refresh',
                                    data
                                }), 
                                false
                            );
                            
                        } // END QUERY CALLBACK FUNCTION
            
                    );  // END QUERY DEFINITION
                    
                } // END ELSE (i.e. NOT allowLegacyAccessRequests)
          
            });  // END DATABASE CONNECTION CALLBACK
            
        }  // END FUNCTION handleAccessRefresh
      
      
      
    
        function handleAccessUpdate(message) {
          //TODO
          
        }
      
      
        function handleAccessAck()  {
            console.log("Received access data acknowledgement from SDP ID "+memberDetails.sdpid+
                ", data successfully delivered");
            
            clearStateVars();
        
        }  // END FUNCTION handleAccessAck

        function getDeviceAttributes(attributes, federatedQuery, callback) {
            if(federatedQuery) {
                callback(attributes);
                return;
            }
            fleetQuery("/api/v1/fleet/hosts/identifier/" + memberDetails.sdpid, 'GET', {}, (host_answer) => {
                var host_id = host_answer["host"]["id"];
                fleetQuery("/api/v1/fleet/queries/" + fleetQueryId + "/run", 'POST', {"host_ids": [host_id]}, (answer) => {
                    attributes["device"] = answer["results"][0]["rows"][0];
                    callback(attributes);
                });
            });
        } // END FUNCTION getDeviceAttributes

        function getServicesOPA(attributes, callback) {
            var postData = JSON.stringify(attributes);
            var answer = "";

            var options = {
                ca: [ fs.readFileSync(config.caCert) ],
                port: config.opaPort,
                hostname: config.opaHostname,
                path: '/',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': postData.length
                }
            };

            var opaConnectError = function(error) {
                console.error("Error connecting to OPA: " + error);

                // notify the requestor of our database troubles
                writeToSocket(socket,
                    JSON.stringify({
                        action: 'service_list_error',
                        data: 'OPA unreachable. Try again soon.'
                    }),
                    false
                );
            };

            var req = https.request(options, (res) => {
                if(res.statusCode != 200) {
                    opaConnectError("Status code " + res.statusCode);
                    return;
                }
                res.on('data', (chunk) => {
                    answer += chunk;
                });
                res.on('end', () => {
                    try {
                        var authorizedServices = JSON.parse(answer);
                        console.log("Connected to OPA. List of authorized services: " + answer);
                        callback(authorizedServices);
                    } catch (err) {
                        opaConnectError(err);
                    }
                });
            });
            
            req.on('error', opaConnectError);

            if(config.debug)
                console.log("Sending query to OPA with the following content:\n" + postData);

            req.write(postData);
            req.end();
        } // END FUNCTION getServicesOPA

        function addServicesDB(authorizedServices, callback) {
            db.getConnection(function(error,connection){
                if(error){
                    console.error("Error connecting to database: " + error);

                    // notify the requestor of our database troubles
                    writeToSocket(socket,
                        JSON.stringify({
                            action: 'service_list_error',
                            data: 'Database unreachable. Try again soon.'
                        }),
                        false
                    );
                    return;
                }

                var databaseErrorCallback = function(error) {
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    console.error("Error from database connection: " + error);
                };
                connection.on('error', databaseErrorCallback);

                connection.query(
                    'INSERT IGNORE INTO `sdpid_service` ' +
                    '(`sdpid`, `service_id`) ' +
                    '(SELECT ?, `service`.`id` FROM `service` ' +
                    'WHERE `service`.`name` IN (?));',
                    [memberDetails.sdpid, authorizedServices],
                    function (error, rows, fields) {
                        connection.removeListener('error', databaseErrorCallback);
                        connection.release();
                        if(error) {
                            console.error("Access data query returned error: " + error);
                            writeToSocket(socket,
                                JSON.stringify({
                                    action: 'service_list_error',
                                    data: 'Database error. Try again soon.'
                                }),
                                false
                            );
                            return;
                        }
                        callback();
                    } // END QUERY CALLBACK FUNCTION
                );  // END QUERY DEFINITION
            });  // END DATABASE CONNECTION CALLBACK
        } // END FUNCTION addServicesDB

        function getServicesDB(services, callback) {
            db.getConnection(function(error,connection){
                if(error){
                    console.error("Error connecting to database: " + error);

                    // notify the requestor of our database troubles
                    writeToSocket(socket,
                        JSON.stringify({
                            action: 'service_list_error',
                            data: 'Database unreachable. Try again soon.'
                        }),
                        false
                    );
                    return;
                }

                var databaseErrorCallback = function(error) {
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    console.error("Error from database connection: " + error);
                };
                connection.on('error', databaseErrorCallback);

                connection.query(
                    'SELECT ' +
                    '    `service_gateway`.`service_id`,  ' +
                    '    `service`.`name`,  ' +
                    '    `service_gateway`.`gateway_sdpid`,  ' +
                    '    `service_gateway`.`protocol`,  ' +
                    '    `service_gateway`.`address`,  ' +
                    '    `service_gateway`.`port` ' +
                    'FROM `service_gateway` ' +
                    '    JOIN `sdpid_service` ' +
                    '        ON `sdpid_service`.`service_id` = `service_gateway`.`service_id` ' +
                    '    JOIN `service` ' +
                    '        ON `sdpid_service`.`service_id` = `service`.`id` ' +
                    'WHERE `sdpid_service`.`sdpid` = ? ' +
                    'ORDER BY `service_id` ',
                    [memberDetails.sdpid],
                    function (error, rows, fields) {
                        connection.removeListener('error', databaseErrorCallback);
                        connection.release();
                        if(error) {
                            console.error("Access data query returned error: " + error);
                            writeToSocket(socket,
                                JSON.stringify({
                                    action: 'service_list_error',
                                    data: 'Database error. Try again soon.'
                                }),
                                false
                            );
                            return;
                        }

                        var lastAddedService = 0;
                        for(var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                            var thisRow = rows[rowIdx];
                            if(thisRow.service_id != lastAddedService) {
                                lastAddedService = thisRow.service_id;
                                services.push({
                                    service_id: thisRow.service_id,
                                    name: thisRow.name,
                                    gateway_sdpid: thisRow.gateway_sdpid,
                                    protocol: thisRow.protocol,
                                    address: thisRow.address,
                                    port: thisRow.port
                                });
                            }
                        }

                        callback();
                    } // END QUERY CALLBACK FUNCTION

                );  // END QUERY DEFINITION
          
            });  // END DATABASE CONNECTION CALLBACK
        } // END FUNCTION getServicesDB

        function getABEKey(attributes, callback) {
            if(config.hasOwnProperty("useABE") && config.useABE) {
                var postData = JSON.stringify({
                    "attributes": attributes["attributes"]
                });
                var answer = "";

                var options = {
                    port: config.abePort,
                    hostname: config.abeHostname,
                    path: "/gen_key",
                    method: "POST",
                    headers: {
                        'Content-Type': 'application/json'
                    }
                };

                var ABEConnectError = function(error) {
                    console.error("Error connecting to ABE: " + error);
                };

                var req = http.request(options, (res) => {
                    if(res.statusCode != 200) {
                        ABEConnectError("Status code " + res.statusCode);
                        return;
                    }
                    res.on('data', (chunk) => {
                        answer += chunk;
                    });
                    res.on('end', () => {
                        callback(answer);
                    });
                });

                req.on('error', ABEConnectError);

                req.write(postData);
                req.end();
            } else
                callback(undefined);
        } // END FUNCTION getABEKey

        function getServiceList(services, attributes, federatedQuery) {
            if(attributes !== undefined) {
                getDeviceAttributes(attributes, federatedQuery, (all_attributes) => {
                    getServicesOPA(all_attributes, (authorizedServices) => {
                        addServicesDB(authorizedServices, () => {
                            getServicesDB(services, () => {
                                getABEKey(attributes, (abeKey) => {
                                    sendServiceList(services, abeKey, false);
                                });
                            });
                        });
                    });
                });
            } else {
                getServicesDB(services, () => {
                    sendServiceList(services, undefined, true);
                });
            }
        } // END FUNCTION getServiceList

        function sendServiceList(services, abeKey, require_login) {
            dataTransmitTries++;
            console.log("Sending service_list message to SDP ID " +
                memberDetails.sdpid + ", attempt: " + dataTransmitTries);

            let answer = {
                action: 'service_list',
                services: services,
            };
            if(abeKey !== undefined)
                answer.abeKey = abeKey;
            if(require_login) {
                sp.create_login_request_url(idp, {}, function(err, login_url, request_id) {
                    if(err != null) {
                        console.error("SP create login request url returned: " + err);
                        writeToSocket(socket,
                            JSON.stringify({
                                action: 'service_list_error',
                                data: 'SP create login error. Please contact an administrator.'
                            }),
                            false
                        );
                        return;
                    }
                    answer.redirect = login_url;
                    writeToSocket(socket,
                        JSON.stringify(answer),
                        false
                    );
                });
            } else {
                writeToSocket(socket,
                    JSON.stringify(answer),
                    false
                );
            }
        } // END FUNCTION sendServiceList

        function updateFwknoprc(new_service, currentFederatedController) {
            if(new_service.name == "controller")
                return;

            var filepath = config.fedfolder + federatedControllers[currentFederatedController].name + "/.fwknoprc";
            var fwknoprc = fs.readFileSync(filepath).toString()
            if(!fwknoprc.includes(`[${new_service.name}]`)) {
                fwknoprc += `\n[${new_service.name}]\n`;
                fwknoprc += `SERVICE_IDS                 ${new_service.service_id}\n`;
                fwknoprc += `SPA_SERVER                  ${new_service.address}\n\n`;
                fs.writeFileSync(filepath, fwknoprc);
            }
        } // END FUNCTION updateFwknoprc

        function getServiceListFederated(samlResponse, cb, services=[], currentFederatedController=0) {
            if(currentFederatedController === federatedControllers.length) {
                cb(services);
                return;
            }
            if(config.debug)
                console.log("Connecting to federated Controller " + federatedControllers[currentFederatedController].name);

            var command = "fwknop --rc-file " + config.fedfolder + federatedControllers[currentFederatedController].name + "/.fwknoprc -n sdp_ctrl_gate";
            if(config.debug) {
                console.log("Sending SPA packet with the command:");
                console.log(command);
            }
            execSync(command);

            var options = {
                ca: [ fs.readFileSync(config.fedfolder + federatedControllers[currentFederatedController].name + "/ca.crt") ],
                key: fs.readFileSync(config.fedfolder + federatedControllers[currentFederatedController].name + "/client.key"),
                cert: fs.readFileSync(config.fedfolder + federatedControllers[currentFederatedController].name + "/client.crt"),
                rejectUnauthorized: true,
                requestCert: true,
                servername: federatedControllers[currentFederatedController].sdpid.toString(),
                host: federatedControllers[currentFederatedController].address,
                port: federatedControllers[currentFederatedController].port
            }
            if(config.debug) {
                console.log("Creating socket with the following options:");
                console.log(options);
            }

            var conn = tls.connect(options, function() {
                if(!conn.authorized) {
                    console.err("TLS session not authorized with federated controller " + federatedControllers[currentFederatedController].name);
                    console.err(conn.authorizationError);
                    return;
                }
            });

            var expectedMessageSize = 0;
            var totalSizeBytesReceived = 0;
            var sizeBytesNeeded = 0;
            var dataBytesToRead = 0;
            var totalMessageBytesReceived = 0;
            var sizeBuffer = Buffer.allocUnsafe(MSG_SIZE_FIELD_LEN);
            var messageBuffer = Buffer.allocUnsafe(0);
            conn.on('data', (data) => {
                while(data.length) {
                    if(expectedMessageSize == 0) {
                        sizeBytesNeeded = MSG_SIZE_FIELD_LEN - totalSizeBytesReceived;
                        // exceptional case, so few bytes arrived
                        // not enough data to read expected message size
                        if( data.length < sizeBytesNeeded ) {
                            data.copy(sizeBuffer, totalSizeBytesReceived, 0, data.length);
                            totalSizeBytesReceived += data.length;
                            data = Buffer.allocUnsafe(0);
                            return;
                        }

                        data.copy(sizeBuffer, totalSizeBytesReceived, 0, sizeBytesNeeded);
                        totalSizeBytesReceived = MSG_SIZE_FIELD_LEN;
                        expectedMessageSize = sizeBuffer.readUInt32BE(0);

                        // time to reset the buffer
                        messageBuffer = Buffer.allocUnsafe(0);
                    }

                    // if there's more data in the received buffer besides the message size field (i.e. actual message contents)
                    if( data.length > sizeBytesNeeded ) {

                        // if there are fewer bytes than what's needed to complete the message
                        if( (data.length - sizeBytesNeeded) < (expectedMessageSize - totalMessageBytesReceived) ){
                            // then read from after the size field to end of the received buffer
                            dataBytesToRead = data.length - sizeBytesNeeded;
                        }
                        else {
                            dataBytesToRead = expectedMessageSize - totalMessageBytesReceived;
                        }

                        totalMessageBytesReceived += dataBytesToRead;
                        messageBuffer = Buffer.concat([messageBuffer,
                            data.slice(sizeBytesNeeded, sizeBytesNeeded+dataBytesToRead)],
                            totalMessageBytesReceived);
                    }

                    // if the message is now complete, process
                    if(totalMessageBytesReceived == expectedMessageSize) {
                        expectedMessageSize = 0;
                        totalSizeBytesReceived = 0;
                        totalMessageBytesReceived = 0;
                        
                        if(config.debug)
                            console.log("Received message: " + messageBuffer.toString());
                        try {
                            var message = JSON.parse(messageBuffer);
                        } catch (err) {
                            console.error("Error processing the following received data: " + messageBuffer.toString());
                            console.error("JSON parse failed with error: " + err);
                            return;
                        }                            
                        
                        if(message.action === "credentials_good") {
                            getDeviceAttributes({}, false, (device_attributes) => {
                                console.log("getDeviceAttributes returned:" + device_attributes);
                                var answer = {
                                    action: "federated_service_list_request",
                                    SAMLResponse: samlResponse,
                                    deviceAttributes: device_attributes,
                                    entityId: config.entityId
                                }
                                writeToSocket(conn, JSON.stringify(answer), false);
                            })
                        }
                        else if(message.action === "service_list") {
                            for(var j=0; j < message.services.length; j++) {
                                var current_service = message.services[j];
                                current_service.federated = currentFederatedController;
                                updateFwknoprc(current_service, currentFederatedController);
                                services.push(current_service);
                            }
                            getServiceListFederated(samlResponse, cb, services, currentFederatedController+1);
                        }
                        else
                            console.error("Action unexpected");
                    }

                    data = data.slice(sizeBytesNeeded+dataBytesToRead);
                    sizeBytesNeeded = 0;
                    dataBytesToRead = 0;
                }
            });

            conn.on('error', (err) => {
                console.error("Could not open mTLS connection with federated controller: " + err);
                conn.end();
            });
        } // END FUNCTION getServiceListFederated

        function handleServiceList(message) {
            if(dataTransmitTries >= config.maxDataTransmitTries) {
                // Data transmission has failed
                console.error("Data transmission to SDP ID " + memberDetails.sdpid +
                  " has failed after " + (dataTransmitTries+1) + " attempts");
                console.error("Closing connection");
                socket.end();
                return;
            }

            if(config.hasOwnProperty("useIdP") &&
               config.useIdP &&
               message.hasOwnProperty("SAMLResponse")) {
                let options = {request_body: message};
                sp.post_assert(idp, options, function(err, saml_response) {
                    if(err != null) {
                        console.error("SP post assert returned: " + err);
                        writeToSocket(socket,
                            JSON.stringify({
                                action: 'service_list_error',
                                data: 'SP post assert error. Please contact an administrator.'
                            }),
                            false
                        );
                        return;
                    }
                    getServiceListFederated(message.SAMLResponse, function (services) {
                        getServiceList(services, saml_response["user"], false);
                    });
                });
            }
            else
                getServiceList([], undefined, false);
        } // END FUNCTION handleServiceList
    
        function handleFederatedServiceList(message) {
            if(dataTransmitTries >= config.maxDataTransmitTries) {
                // Data transmission has failed
                console.error("Data transmission to SDP ID " + memberDetails.sdpid +
                  " has failed after " + (dataTransmitTries+1) + " attempts");
                console.error("Closing connection");
                socket.end();
                return;
            }

            // Verifying SAML Assertion
            var temp_sp = new saml2.ServiceProvider({
                entity_id: message.entityId,
                private_key: "NA",
                certificate: "NA",
                assert_endpoint: "NA",
                allow_unencrypted_assertion: true
            });
            var temp_idp = new saml2.IdentityProvider({
                sso_login_url: "NA",
                sso_logout_url: "NA",
                certificates: fs.readFileSync(config.fedfolder + memberDetails.sdpid + ".crt").toString()
            });
            var options = {
                ignore_timing: true,
                request_body: {SAMLResponse: message.SAMLResponse}
            };
            temp_sp.post_assert(temp_idp, options, function(err, saml_response) {
                if(err != null) {
                    console.error("SP post assert returned: " + err);
                        writeToSocket(socket,
                            JSON.stringify({
                                action: 'federated_service_list_error',
                                data: 'SP post assert error. Please contact an administrator.'
                            }),
                            false
                        );
                        return;
                }
                var attributes = saml_response["user"];
                attributes["device"] = message.deviceAttributes["device"];
                getServiceList([], attributes, true);
            });
        } // END FUNCTION handleFederatedServiceList

        function handleFederatedSPA(message) {
            var command = "fwknop --rc-file " + config.fedfolder + federatedControllers[parseInt(message.federated)].name + "/.fwknoprc -n " + message.name + " -a " + message.ip;
            if(config.debug) {
                console.log("Sending SPA packet with the command:");
                console.log(command);
            }
            try {
                execSync(command);
                writeToSocket(socket, 
                    JSON.stringify({
                        action: 'federated_spa_sent'
                    }), 
                    false
                );
            } catch (err) {
                console.error("Error sending SPA with command:");
                console.error(command);
                console.error(err);
                writeToSocket(socket, 
                    JSON.stringify({
                        action: 'federated_spa_error',
                        data: 'Could not send SPA to gateway.'
                    }), 
                    false
                );
            }
        } // END FUNCTION handleFederatedSPA

        function handleRemoteAttestation(message) {
            if(!message.attestation_result) {
                console.log("Attestation result is false");
                db.getConnection(function(error,connection){
                    if(error){
                        console.error("Error connecting to database: " + error);
    
                        // notify the requestor of our database troubles
                        writeToSocket(socket,
                            JSON.stringify({
                                action: 'remote_attestation_error',
                                data: 'Database unreachable. Try again soon.'
                            }),
                            false
                        );
    
                        return;
                    }
    
                    var databaseErrorCallback = function(error) {
                        connection.removeListener('error', databaseErrorCallback);
                        connection.release();
                        console.error("Error from database connection: " + error);
                        return;
                    };
    
                    connection.on('error', databaseErrorCallback);
                        
                    connection.query(
                        'UPDATE `sdpid` SET ' +
                        '`cred_update_due` = ? ' +
                        'WHERE `sdpid` = ?; ' +
                        'DELETE FROM `sdpid_service` ' +
                        'WHERE `sdpid` = ? AND `service_id` != 1',
                        [new Date(), message.sdpid, message.sdpid],
                        function (error, rows, fields) {
                            connection.removeListener('error', databaseErrorCallback);
                            connection.release();
                            if(error) {
                                console.error("Access data query returned error: " + error);
                                writeToSocket(socket,
                                    JSON.stringify({
                                        action: 'remote_attestation_error',
                                        data: 'Database error. Try again soon.'
                                    }),
                                    false
                                );
                            }

                        } // END QUERY CALLBACK FUNCTION
    
                    );  // END QUERY DEFINITION
              
                });  // END DATABASE CONNECTION CALLBACK

            } // END IF attestation_result

            dataTransmitTries++;
            writeToSocket(socket,
                JSON.stringify({action: "remote_attestation_ack"}),
                false);

        } // END FUNCTION handleRemoteAttestation
    
        function handleConnectionUpdate(message) {
            console.log("Received connection update message from SDP ID "+memberDetails.sdpid);
            
            // convert conn data into nested array for sql query
            var openConns = [];
            var closedConns = [];
            var deleteConns = [];
            var dest = null;
            var natIp = null;
            var natPort = 0;
            message['data'].forEach(function(element, index, array) {
                if( !(
                        element.hasOwnProperty('sdp_id') &&
                        element.hasOwnProperty('service_id') &&
                        element.hasOwnProperty('start_timestamp') &&
                        element.hasOwnProperty('end_timestamp') &&
                        element.hasOwnProperty('protocol') &&
                        element.hasOwnProperty('source_ip') &&
                        element.hasOwnProperty('source_port') &&
                        element.hasOwnProperty('destination_ip') &&
                        element.hasOwnProperty('destination_port')
                    )) { 
                    console.log("Received connection element with missing data. Dropping element.\n");
                    return; 
                }
                    
                if(element.hasOwnProperty('nat_destination_ip'))
                    natIp = element['nat_destination_ip'];
                else
                    natIp = '';
                    
                if(element.hasOwnProperty('nat_destination_port'))
                    natPort = element['nat_destination_port'];
                else
                    natPort = 0;
                    
                if(element['end_timestamp'] == 0)
                    openConns.push([  memberDetails.sdpid,
                                      element['sdp_id'],
                                      element['service_id'],
                                      element['start_timestamp'],
                                      element['end_timestamp'],
                                      element['protocol'],
                                      element['source_ip'],
                                      element['source_port'],
                                      element['destination_ip'],
                                      element['destination_port'],
                                      natIp,
                                      natPort,
                                      connectionId
                                   ]);
                else {
                    closedConns.push([  memberDetails.sdpid,
                                        element['sdp_id'],
                                        element['service_id'],
                                        element['start_timestamp'],
                                        element['end_timestamp'],
                                        element['protocol'],
                                        element['source_ip'],
                                        element['source_port'],
                                        element['destination_ip'],
                                        element['destination_port'],
                                        natIp,
                                        natPort
                                     ]);
                    
                    deleteConns.push([  connectionId,
                                        element['sdp_id'],
                                        element['start_timestamp'],
                                        element['source_port']
                                     ]);          
                }
                    
            });
            
            if(config.debug) {
                console.log("Received connection update message:\n"+ 
                            "     Gateway SDP ID: %d \n"+
                            "   Connection count: %d \n",
                            memberDetails.sdpid,
                            message['data'].length);
            }
            
            storeConnectionsInDatabase(openConns, closedConns, deleteConns);
            return;
        }
      
    
    
        // whenever a gateway disconnects from the controller for any reason, 
        // move it's open connections to the closed table,
        // if the gateway reconnects and conns are actually still open,
        // the gateway will resend the open conns
        function removeOpenConnections(connectionId) {
            // get database connection
            db.getConnection(function(error,connection){
                if(error){
                    databaseConnTries++;
                    
                    console.error("Error connecting to database in preparation " + 
                                  "to remove open connections: " + error);
                                  
                    // retry soon
                    setTimeout(removeOpenConnections, config.databaseRetryInterval, connectionId);
                    return;
                }
                
                var databaseErrorCallback = function(error) {
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    console.error("Error from database connection: " + error);
                    return;
                };
            
                connection.on('error', databaseErrorCallback);
                
                // got a connection to the database
                databaseConnTries = 0;
                
                connection.query(
                    'SELECT * ' +
                    'FROM `open_connection` ' +
                    'WHERE `gateway_controller_connection_id` = ? ',
                    [connectionId],
                    function (error, rows, fields) {
                        connection.removeListener('error', databaseErrorCallback);
                        connection.release();
                        if(error) {
                            console.error("removeOpenConnections query returned error: " + error);
                            return;
                        }
                        
                        if(rows.length == 0) {
                            if(config.debug) console.log("No open connections found that need to be removed.");
                            return;
                        }
                        
                        if(config.debug) console.log("removeOpenConnections query found connections that need removal.");
                                    
                        var deleteList = [];
                        var closeList = [];
                        var conn = null;
                        var now = new Date().valueOf() / 1000;
                        for(var idx = 0; idx < rows.length; idx++)
                        {
                            conn = rows[idx];
                            
                            closeList.push(
                            [
                                conn.gateway_sdpid,
                                conn.client_sdpid,
                                conn.service_id,
                                conn.start_timestamp,
                                now,
                                conn.protocol,
                                conn.source_ip,
                                conn.source_port,
                                conn.destination_ip,
                                conn.destination_port,
                                conn.nat_destination_ip,
                                conn.nat_destination_port
                            ]);
        
                            deleteList.push(
                            [
                                connectionId,
                                conn.client_sdpid,
                                conn.start_timestamp,
                                conn.source_port
                            ]);
                            
                        }
                        
                        storeConnectionsInDatabase(null, closeList, deleteList);
        
                        
                    }  // END QUERY CALLBACK FUNCTION
                    
                ); // END QUERY CALL 
                
            });  // END db.getConnection
            
        }  // END FUNCTION removeOpenConnections
    
    
    
        // store connections in database
        function storeConnectionsInDatabase(openConns, closedConns, deleteConns) {
            db.getConnection(function(error,connection){
                if(error){
                    console.error("Error connecting to database to store connections");
                    console.error(error);
                    databaseConnTries++;
                    
                    if(databaseConnTries >= config.databaseMaxRetries) {
                        console.error("Too many database connection failures. Dropping connection data.");
                        databaseConnTries = 0;
                        return;
                    }
                    
                    // retry soon
                    setTimeout(storeConnectionsInDatabase, 
                               config.databaseRetryInterval, 
                               openConns, 
                               closedConns, 
                               deleteConns);
                    return;
                }
                
                // got connection, reset counter
                databaseConnTries = 0;
                
                var databaseErrorCallback = function(error) {
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    console.error("Error from database connection: " + error);
                    return;
                };
                
                connection.on('error', databaseErrorCallback);
                
                if(openConns != null && openConns.length > 0) {
                    connection.query(
                        'INSERT IGNORE INTO `open_connection` (`gateway_sdpid`, `client_sdpid`, ' +
                        '`service_id`, `start_timestamp`, `end_timestamp`, `protocol`, ' +
                        '`source_ip`, `source_port`, `destination_ip`, `destination_port`, ' +
                        '`nat_destination_ip`, `nat_destination_port`, `gateway_controller_connection_id`) ' +
                        'VALUES ? ',
                        //'ON DUPLICATE KEY UPDATE ' +
                        //'`end_timestamp` = VALUES(`end_timestamp`)',
                        [openConns],
                        function (error, rows, fields){
                            if (error)
                            {
                                console.error("Failed when writing open connections to database.");
                                console.error(error);
                                return;
                            } 
                            
                            console.log("Successfully stored open connection data in the database");
                        }
                    );
                }
                
                if(closedConns != null && closedConns.length > 0) {
                    connection.query(
                        'INSERT INTO `closed_connection` (`gateway_sdpid`, `client_sdpid`, ' +
                        '`service_id`, `start_timestamp`, `end_timestamp`, `protocol`, ' +
                        '`source_ip`, `source_port`, `destination_ip`, `destination_port`, ' +
                        '`nat_destination_ip`, `nat_destination_port`) ' +
                        'VALUES ? '+
                        'ON DUPLICATE KEY UPDATE ' +
                        '`end_timestamp` = VALUES(`end_timestamp`)',
                        [closedConns],
                        function (error, rows, fields){
                            if (error)
                            {
                                console.error("Failed when writing closed connections to database.");
                                console.error(error);
                                return;
                            } 
                            
                            console.log("Successfully stored closed connection data in the database");
                        }
                    );
                  
                    connection.query(
                        'DELETE FROM `open_connection` WHERE ' +
                        '(`gateway_controller_connection_id`, `client_sdpid`, `start_timestamp`, `source_port`) ' +
                        'IN (?) ',
                        [deleteConns],
                        function (error, rows, fields){
                            if (error)
                            {
                                console.error("Failed when removing closed connections from open_connection table.");
                                console.error(error);
                                return;
                            } 
                            
                            console.log("Successfully removed closed connections from open_connection table.");
                        }
                    );
                }
        
                connection.removeListener('error', databaseErrorCallback);
                connection.release();
            });
        
        }
    
    
        // store generated keys in database
        function storeKeysInDatabase() {
            if (newKeys.hasOwnProperty('spa_encryption_key_base64') && 
                newKeys.hasOwnProperty('spa_hmac_key_base64')) 
            {
                if(config.debug)
                    console.log("Found the new keys to store in database for SDP ID "+sdpId);
                
                db.getConnection(function(error,connection){
                    if(error){
                        console.error("Error connecting to database to store new keys for SDP ID "+sdpId);
                        console.error(error);
                        databaseConnTries++;
                        
                        if(databaseConnTries >= config.databaseMaxRetries) {
                            console.error("Too many database connection failures. Dropping key data.");
                            databaseConnTries = 0;
                            return;
                        }
                                    
                        // retry soon
                        setTimeout(storeKeysInDatabase, config.databaseRetryInterval);
                        return;
                    }
                    
                    // got connection, reset counter
                    databaseConnTries = 0;
                    
                    var databaseErrorCallback = function(error) {
                        connection.removeListener('error', databaseErrorCallback);
                        connection.release();
                        console.error("Error from database connection: " + error);
                        return;
                    };
                    
                    connection.on('error', databaseErrorCallback);
                    
                    connection.query(
                        'UPDATE `sdpid` SET ' +
                        '`encrypt_key` = ?, `hmac_key` = ?, ' +
                        '`last_cred_update` = ?, `cred_update_due` = ? WHERE `sdpid` = ?', 
                        [newKeys.spa_encryption_key_base64,
                         newKeys.spa_hmac_key_base64,
                         newKeys.updated,
                         newKeys.expires,
                         memberDetails.sdpid],
                        function (error, rows, fields){
                            connection.removeListener('error', databaseErrorCallback);
                            connection.release();
                            if (error)
                            {
                                console.error("Failed when writing keys to database for SDP ID "+sdpId);
                                console.error(error);
                                newKeys = null;
                                clearStateVars();
                                return;
                            } 
                            
                            console.log("Successfully stored new keys for SDP ID "+sdpId+" in the database");
                            newKeys = null;
                            clearStateVars();
                            notifyGateways();
                        }
                      
                    );
                  
                });
            
            } else {
                console.error("Did not find keys to store in database for SDP ID "+sdpId);
                clearStateVars();
            }
        }
    
    
        // clear all state variables
        function clearStateVars() {
            action = null;
            dataTransmitTries = 0;
            credentialMakerTries = 0;
            badMessagesReceived = 0;
        }
    
    
        // deal with receipt of bad messages
        function handleBadMessage(badMessage) {
            badMessagesReceived++;
            
            console.error("In handleBadMessage, badMessage:\n" +badMessage);
            
            if (badMessagesReceived < config.maxBadMessages) {
            
                console.error("Preparing badMessage message...");
                var badMessageMessage = {
                    action: 'bad_message',
                    data: badMessage
                };
                
                console.error("Message to send:");
                for(var myKey in badMessageMessage) {
                    console.log("key: " + myKey + "   value: " + badMessageMessage[myKey]);
                }
                writeToSocket(socket, JSON.stringify(badMessageMessage), false);
            
            } else {
            
                console.error("Received " + badMessagesReceived + " badly formed messages from SDP ID " +
                    sdpId);
                console.error("Closing connection");
                socket.end();
            }
        }
    
    }).listen(config.serverPort);
    
    if(config.maxConnections) server.maxConnections = config.maxConnections;
    
    // Put a friendly message on the terminal of the server.
    console.log("SDP Controller running at port " + config.serverPort);
}  // END function startServer


function writeToSocket(theSocket, theMsg, endTheSocket) {
    if(config.debug)
        console.log("\n\nSENDING MESSAGE:\n"+theMsg+"\n\n");
    var theMsg_buf = Buffer.allocUnsafe(MSG_SIZE_FIELD_LEN + theMsg.length);
    theMsg_buf.writeUInt32BE(theMsg.length, 0);
    theMsg_buf.write(theMsg, MSG_SIZE_FIELD_LEN);
    theSocket.write(theMsg_buf);

    if(endTheSocket) {
        theSocket.end();
    }
}



function cleanOpenConnectionTable() {
    // get database connection
    db.getConnection(function(error,connection){
        if(error){
            console.error("Error connecting to database to clean " + 
                          "open_connection table: " + error);
                          
            throw error;
        }
        
        var databaseErrorCallback = function(error) {
            connection.removeListener('error', databaseErrorCallback);
            connection.release();
            console.error("Error from database connection: " + error);
            throw error;
        };
    
        connection.on('error', databaseErrorCallback);
        
        connection.query(
            'SELECT * FROM `open_connection` ',
            function (error, rows, fields) {
                if(error) {
                    console.error("Database query to clean open_connection " +
                                  "table returned error: " + error);
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    throw error;
                }
                
                if(rows.length == 0) {
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    if(config.debug) console.log("No open connections found that need to be removed.");
                    return;
                }
                
                if(config.debug) console.log("removeOpenConnections query found connections that need removal.");
                            
                var closeList = [];
                var conn = null;
                var now = new Date().valueOf() / 1000;
                for(var idx = 0; idx < rows.length; idx++)
                {
                    conn = rows[idx];
                    
                    closeList.push(
                    [
                        conn.gateway_sdpid,
                        conn.client_sdpid,
                        conn.service_id,
                        conn.start_timestamp,
                        now,
                        conn.protocol,
                        conn.source_ip,
                        conn.source_port,
                        conn.destination_ip,
                        conn.destination_port,
                        conn.nat_destination_ip,
                        conn.nat_destination_port
                    ]);
                    
                }  // END rows FOR LOOP
                
                connection.query(
                    'INSERT INTO `closed_connection` (`gateway_sdpid`, `client_sdpid`, ' +
                    '`service_id`, `start_timestamp`, `end_timestamp`, `protocol`, ' +
                    '`source_ip`, `source_port`, `destination_ip`, `destination_port`, ' +
                    '`nat_destination_ip`, `nat_destination_port`) ' +
                    'VALUES ? '+
                    'ON DUPLICATE KEY UPDATE ' +
                    '`end_timestamp` = VALUES(`end_timestamp`)',
                    [closeList],
                    function (error, rows, fields){
                        if (error)
                        {
                            console.error("Failed when writing closed connections to database.");
                            console.error(error);
                            connection.removeListener('error', databaseErrorCallback);
                            connection.release();
                            throw error;
                        } 
                        
                        console.log("Successfully stored closed connection data in the database");
                    }
                );

                connection.query(
                    'DELETE FROM `open_connection` ',
                    function (error, rows, fields) {
                        if(error) {
                            console.error("Database query to clean open_connection " +
                                          "table returned error: " + error);
                            connection.removeListener('error', databaseErrorCallback);
                            connection.release();
                            throw error;
                        }
                    }
                );
                
                connection.removeListener('error', databaseErrorCallback);
                connection.release();

            }  // END QUERY CALLBACK FUNCTION
            
        ); // END QUERY CALL 

    });  // END db.getConnection
    
}  // END FUNCTION cleanOpenConnectionTable

function getFederatedControllers() {
    db.getConnection(function(error,connection){
        if(error){
            console.error("Error connecting to database to get " + 
                          "federated controllers: " + error);
                          
            throw error;
        }
        
        var databaseErrorCallback = function(error) {
            connection.removeListener('error', databaseErrorCallback);
            connection.release();
            console.error("Error from database connection: " + error);
            throw error;
        };
    
        connection.on('error', databaseErrorCallback);
        
        connection.query(
            'SELECT * FROM `federated_controllers` ',
            function (error, rows, fields) {
                if(error) {
                    console.error("Database query to get federated controllers " +
                                  "returned error: " + error);
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    throw error;
                }
                
                if(rows.length == 0) {
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    if(config.debug) console.log("No federated controller found.");
                    return;
                }
                
                if(config.debug) console.log("getFederatedControllers query found federated controllers.");
                            
                for(var idx = 0; idx < rows.length; idx++) {
                    federatedControllers.push({
                        "name": rows[idx].name,
                        "protocol": rows[idx].protocol,
                        "address": rows[idx].address,
                        "port": rows[idx].port,
                        "sdpid": rows[idx].sdpid
                    });
                }
                
                connection.removeListener('error', databaseErrorCallback);
                connection.release();

            }  // END QUERY CALLBACK FUNCTION
            
        ); // END QUERY CALL 

    });  // END db.getConnection
} // END FUNCTION getFederatedControllers


function checkDatabaseForUpdates(currentInterval) {
    // only run this check if a gateway or gateways are connected
    if(connectedGateways.length == 0) {
        setTimeout(checkDatabaseForUpdates, config.databaseMonitorInterval, currentInterval);
        return;
    }
    
    // get database connection
    db.getConnection(function(error,connection){
        if(error){
            checkDatabaseTries++;
            currentInterval = currentInterval*2;
            
            console.error("Error connecting to database in preparation " + 
                          "to check for database updates: " + error);
                          
            console.error("Number of consecutive database check failures: "
                          +checkDatabaseTries);
                          
            console.error("Doubling database monitoring interval, will retry in "
                          +currentInterval+" milliseconds.");
            
            // retry soon
            setTimeout(checkDatabaseForUpdates, config.databaseMonitorInterval, currentInterval);
            return;
        }
        
        var databaseErrorCallback = function(error) {
            connection.removeListener('error', databaseErrorCallback);
            connection.release();
            console.error("Error from database connection: " + error);
            // retry soon
            setTimeout(checkDatabaseForUpdates, config.databaseMonitorInterval, currentInterval);
            return;
        };
    
        connection.on('error', databaseErrorCallback);
        
        // got a connection to the database, make sure interval is correct
        currentInterval = config.databaseMonitorInterval;
        checkDatabaseTries = 0;
        
        connection.query(
            'SELECT ' +
            '    `timestamp`, `table_name` ' +
            'FROM `refresh_trigger` ' +
            'WHERE `timestamp` >= ? ',
            [lastDatabaseCheck],
            function (error, rows, fields) {
                if(error) {
                    console.error("Database monitoring query returned error: " + error);
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    setTimeout(checkDatabaseForUpdates, config.databaseMonitorInterval, currentInterval);
                    return;
                }
                
                if(rows.length == 0) {
                    if(config.debug) console.log("No database updates found requiring access data refresh.");
                    //console.log("No database updates found requiring access data refresh.");
                    connection.removeListener('error', databaseErrorCallback);
                    connection.release();
                    setTimeout(checkDatabaseForUpdates, config.databaseMonitorInterval, currentInterval);
                    return;
                }
                
                // arriving here means a relevant database update occurred
                console.log("checkDatabaseForUpdates query found relevant updates, " +
                            "sending data refresh to all connected gateways.");
                            
                // if any of the database events involved a change to a service
                // the refresh must include a service refresh
                // access refresh must always be done
                var doServiceRefresh = false;
                
                for(var idx = 0; idx < rows.length; idx++) 
                {
                    if(rows[idx].table_name == 'service' ||
                       rows[idx].table_name == 'service_gateway') 
                    {
                        doServiceRefresh = true;
                        break;
                    }
                }
                
                // the other queries require a simple array of only
                // the sdp ids listed in connectedGateways
                var gatewaySdpIdList = [];
                for(var idx = 0; idx < connectedGateways.length; idx++) {
                    gatewaySdpIdList.push(connectedGateways[idx].sdpId);
                }

                if(gatewaySdpIdList.length < 1)
                {
                    console.log("No relevant gateways to notify regarding database update.");
                    return;
                }
                
                if(doServiceRefresh)
                {
                    // this will call the access refresh function when it's done
                    sendAllGatewaysServiceRefresh(connection, databaseErrorCallback, gatewaySdpIdList);
                }
                else
                {
                    sendAllGatewaysAccessRefresh(connection, databaseErrorCallback, gatewaySdpIdList);
                }

                // Arriving here means the database check was successful
                lastDatabaseCheck = new Date();
                currentInterval = config.databaseMonitorInterval;
                setTimeout(checkDatabaseForUpdates, config.databaseMonitorInterval, currentInterval);
                
            }  // END QUERY CALLBACK FUNCTION
            
        ); // END QUERY CALL 
        
    });  // END db.getConnection
    
}  // END FUNCTION checkDatabaseForUpdates


                
function sendAllGatewaysServiceRefresh(connection, databaseErrorCallback, gatewaySdpIdList) 
{
    connection.query(
        'SELECT ' +
        '    `service_gateway`.`protocol`,  ' +
        '    `service_gateway`.`gateway_sdpid`,  ' +
        '    `service_gateway`.`service_id`,  ' +
        '    `service_gateway`.`port`, ' +
        '    `service_gateway`.`nat_ip`, ' +
        '    `service_gateway`.`nat_port` ' +
        'FROM `service_gateway` ' +
        'WHERE `service_gateway`.`gateway_sdpid` IN (?) ' +
        'ORDER BY gateway_sdpid ',
        [gatewaySdpIdList],
        function (error, rows, fields) {
            if(error) {
                connection.removeListener('error', databaseErrorCallback);
                connection.release();
                console.error("Service data query returned error: " + error);
                return;
            }
            
            if(rows.length == 0) {
                connection.removeListener('error', databaseErrorCallback);
                connection.release();
                console.log("No relevant gateways to notify regarding service data refresh.");
                return;
            }
            
            console.log("Sending service refresh to all connected gateways.");
            
            var data = [];
            var thisRow = rows[0];
            var currentGatewaySdpId = 0; 
            var gatewaySocket = null;
            
            for(var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                thisRow = rows[rowIdx];
                
                // if we hit a new gateway, start fresh
                if(thisRow.gateway_sdpid != currentGatewaySdpId) {
                    currentGatewaySdpId = thisRow.gateway_sdpid;
                    data = [];
                    
                    // get the right socket
                    gatewaySocket = null;
                    for(var idx = 0; idx < connectedGateways.length; idx++) {
                        if(connectedGateways[idx].sdpId == currentGatewaySdpId) {
                            gatewaySocket = connectedGateways[idx].socket;
                            break;
                        }
                    }
                    
                    if(!gatewaySocket) {
                        console.error("Preparing to send service refresh to gateway with SDP ID " +currentGatewaySdpId+
                                      ", but socket not found.");
                        
                        // skip past all rows with this gateway sdp id
                        while( (rowIdx + 1) < rows.length &&
                               rows[rowIdx + 1].gateway_sdpid == currentGatewaySdpId) {
                            rowIdx++;
                        }
                        continue;
                    }
                } 
                
                if(thisRow.nat_ip != '' && thisRow.nat_port != 0) {
                    data.push({
                        service_id: thisRow.service_id,
                        proto: thisRow.protocol,
                        port: thisRow.port,
                        nat_ip: thisRow.nat_ip,
                        nat_port: thisRow.nat_port,
                    });
                } else {
                    data.push({
                        service_id: thisRow.service_id,
                        proto: thisRow.protocol,
                        port: thisRow.port,
                    });
                }
                
                // if this is the last data row or the next is a different gateway
                if( (rowIdx + 1) == rows.length || 
                    rows[rowIdx + 1].gateway_sdpid != currentGatewaySdpId ) {
                    
                    // send off this gateway's data
                    if(config.debug) {
                        console.log("Service refresh data to send to "+currentGatewaySdpId+": \n", data);
                    }
                    
                    console.log("Sending service_refresh message to SDP ID " + currentGatewaySdpId);
            
                    writeToSocket(gatewaySocket,
                        JSON.stringify({
                            action: 'service_refresh',
                            data
                        }),
                        false
                    );
                    
                } // END IF LAST ROW FOR THIS GATE

            } // END QUERY DATA FOR LOOP
            
            
            sendAllGatewaysAccessRefresh(connection, databaseErrorCallback, gatewaySdpIdList);
            

        } // END QUERY CALLBACK FUNCTION

    );  // END QUERY DEFINITION
            
}  // END FUNCTION sendAllGatewaysServiceRefresh


function sendAllGatewaysAccessRefresh(connection, databaseErrorCallback, gatewaySdpIdList) 
{
    if(config.allowLegacyAccessRequests)
    {
        connection.query(
            '(SELECT ' +
            '    `service_gateway`.`gateway_sdpid` as gatewaySdpId, ' +
            '    `service_gateway`.`service_id`, ' +
            '    `service_gateway`.`protocol`, ' +
            '    `service_gateway`.`port`, ' +
            '    `sdpid`.`sdpid` as clientSdpId, ' +
            '    `sdpid`.`encrypt_key`,  ' +
            '    `sdpid`.`hmac_key` ' +
            'FROM `service_gateway` ' +
            '    JOIN `sdpid_service` ' +
            '        ON `sdpid_service`.`service_id` = `service_gateway`.`service_id` ' +
            '    JOIN `sdpid` ' +
            '        ON `sdpid`.`sdpid` = `sdpid_service`.`sdpid` ' +
            'WHERE `sdpid`.`valid` = 1 AND `service_gateway`.`gateway_sdpid` IN (?) )' +
            'UNION ' +
            '(SELECT ' +
            '    `service_gateway`.`gateway_sdpid` as gatewaySdpId, ' +
            '    `group_service`.`service_id`,  ' +
            '    `service_gateway`.`protocol`, ' +
            '    `service_gateway`.`port`, ' +
            '    `sdpid`.`sdpid` as clientSdpId, ' +
            '    `sdpid`.`encrypt_key`,  ' +
            '    `sdpid`.`hmac_key` ' +
            'FROM `service_gateway` ' +
            '    JOIN `group_service` ' +
            '        ON `group_service`.`service_id` = `service_gateway`.`service_id` ' +
            '    JOIN `group` ' +
            '        ON `group`.`id` = `group_service`.`group_id` ' +
            '    JOIN `user_group` ' +
            '        ON `user_group`.`group_id` = `group`.`id` ' +
            '    JOIN `sdpid` ' +
            '        ON `sdpid`.`user_id` = `user_group`.`user_id` ' +
            'WHERE ' +
            '    `sdpid`.`valid` = 1 AND ' +
            '    `group`.`valid` = 1 AND ' +
            '    `service_gateway`.`gateway_sdpid` IN (?) )' +
            'ORDER BY gatewaySdpId, clientSdpId ',
            [gatewaySdpIdList, gatewaySdpIdList],
            function (error, rows, fields) {
                connection.removeListener('error', databaseErrorCallback);
                connection.release();
                if(error) {
                    console.error("Access data refresh query returned error: " + error);
                    return;
                }
                
                if(rows.length == 0) {
                    console.log("No relevant gateways to notify regarding access data refresh.");
                    return;
                }
                
                console.log("Sending access refresh to all connected gateways.");
    
                var data = [];
                var dataIdx = 0;
                var thisRow = rows[0];
                var currentGatewaySdpId = 0; 
                var currentClientSdpId = 0;
                var gatewaySocket = null;
                
                for(var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                    thisRow = rows[rowIdx];
                    
                    // if we hit a new gateway, start fresh
                    if(thisRow.gatewaySdpId != currentGatewaySdpId) {
                        currentGatewaySdpId = thisRow.gatewaySdpId;
                        data = [];
                        currentClientSdpId = 0;
                        
                        // get the right socket
                        gatewaySocket = null;
                        for(var idx = 0; idx < connectedGateways.length; idx++) {
                            if(connectedGateways[idx].sdpId == currentGatewaySdpId) {
                                gatewaySocket = connectedGateways[idx].socket;
                                break;
                            }
                        }
                        
                        if(!gatewaySocket) {
                            console.error("Preparing to send access refresh to gateway with SDP ID " +currentGatewaySdpId+
                                          ", but socket not found.");
                            
                            // skip past all rows with this gateway sdp id
                            while( (rowIdx + 1) < rows.length &&
                                   rows[rowIdx + 1].gatewaySdpId == currentGatewaySdpId) {
                                rowIdx++;
                            }
                            continue;
                        }
                    } 
                    
                    if(thisRow.clientSdpId != currentClientSdpId) {
                        currentClientSdpId = thisRow.clientSdpId;
                        data.push({
                            sdp_id: thisRow.clientSdpId,
                            source: "ANY",
                            service_list: thisRow.service_id.toString(),
                            open_ports: thisRow.protocol + "/" + thisRow.port,
                            spa_encryption_key_base64: thisRow.encrypt_key,
                            spa_hmac_key_base64: thisRow.hmac_key
                        });
                    } else {
                        data[dataIdx].service_list += ", " + thisRow.service_id.toString();
                        data[dataIdx].open_ports += ", " + thisRow.protocol + "/" + thisRow.port;
                    }
    
                    dataIdx = data.length - 1;
    
                    // if this is the last data row or the next is a different gateway
                    if( (rowIdx + 1) == rows.length || 
                        rows[rowIdx + 1].gatewaySdpId != currentGatewaySdpId ) {
                        
                        // send off this gateway's data
                        if(config.debug) {
                            console.log("Access refresh data to send to "+currentGatewaySdpId+": \n", data);
                        }
                        
                        console.log("Sending access_refresh message to SDP ID " + currentGatewaySdpId);
                
                        writeToSocket(gatewaySocket,
                            JSON.stringify({
                                action: 'access_refresh',
                                data
                            }),
                            false
                        );
                        
                    } // END IF LAST ROW FOR THIS GATE
    
                } // END QUERY DATA FOR LOOP
                
        
    
            } // END QUERY CALLBACK FUNCTION
    
        );  // END QUERY DEFINITION
        
    }  // END IF allowLegacyAccessRequests
    else
    {
        connection.query(
            '(SELECT ' +
            '    `service_gateway`.`gateway_sdpid` as gatewaySdpId, ' +
            '    `service_gateway`.`service_id`, ' +
            '    `sdpid`.`sdpid` as clientSdpId, ' +
            '    `sdpid`.`encrypt_key`,  ' +
            '    `sdpid`.`hmac_key` ' +
            'FROM `service_gateway` ' +
            '    JOIN `sdpid_service` ' +
            '        ON `sdpid_service`.`service_id` = `service_gateway`.`service_id` ' +
            '    JOIN `sdpid` ' +
            '        ON `sdpid`.`sdpid` = `sdpid_service`.`sdpid` ' +
            'WHERE `sdpid`.`valid` = 1 AND `service_gateway`.`gateway_sdpid` IN (?) )' +
            'UNION ' +
            '(SELECT ' +
            '    `service_gateway`.`gateway_sdpid` as gatewaySdpId, ' +
            '    `group_service`.`service_id`,  ' +
            '    `sdpid`.`sdpid` as clientSdpId, ' +
            '    `sdpid`.`encrypt_key`,  ' +
            '    `sdpid`.`hmac_key` ' +
            'FROM `service_gateway` ' +
            '    JOIN `group_service` ' +
            '        ON `group_service`.`service_id` = `service_gateway`.`service_id` ' +
            '    JOIN `group` ' +
            '        ON `group`.`id` = `group_service`.`group_id` ' +
            '    JOIN `user_group` ' +
            '        ON `user_group`.`group_id` = `group`.`id` ' +
            '    JOIN `sdpid` ' +
            '        ON `sdpid`.`user_id` = `user_group`.`user_id` ' +
            'WHERE ' +
            '    `sdpid`.`valid` = 1 AND ' +
            '    `group`.`valid` = 1 AND ' +
            '    `service_gateway`.`gateway_sdpid` IN (?) )' +
            'ORDER BY gatewaySdpId, clientSdpId ',
            [gatewaySdpIdList, gatewaySdpIdList],
            function (error, rows, fields) {
                connection.removeListener('error', databaseErrorCallback);
                connection.release();
                if(error) {
                    console.error("Access data refresh query returned error: " + error);
                    return;
                }
                
                if(rows.length == 0) {
                    console.log("No relevant gateways to notify regarding access data refresh.");
                    return;
                }
                
                console.log("Sending access refresh to all connected gateways.");
    
                var data = [];
                var dataIdx = 0;
                var thisRow = rows[0];
                var currentGatewaySdpId = 0; 
                var currentClientSdpId = 0;
                var gatewaySocket = null;
                
                for(var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                    thisRow = rows[rowIdx];
                    
                    // if we hit a new gateway, start fresh
                    if(thisRow.gatewaySdpId != currentGatewaySdpId) {
                        currentGatewaySdpId = thisRow.gatewaySdpId;
                        data = [];
                        currentClientSdpId = 0;
                        
                        // get the right socket
                        gatewaySocket = null;
                        for(var idx = 0; idx < connectedGateways.length; idx++) {
                            if(connectedGateways[idx].sdpId == currentGatewaySdpId) {
                                gatewaySocket = connectedGateways[idx].socket;
                                break;
                            }
                        }
                        
                        if(!gatewaySocket) {
                            console.error("Preparing to send access refresh to gateway with SDP ID " +currentGatewaySdpId+
                                          ", but socket not found.");
                            
                            // skip past all rows with this gateway sdp id
                            while( (rowIdx + 1) < rows.length &&
                                   rows[rowIdx + 1].gatewaySdpId == currentGatewaySdpId) {
                                rowIdx++;
                            }
                            continue;
                        }
                    } 
                    
                    if(thisRow.clientSdpId != currentClientSdpId) {
                        currentClientSdpId = thisRow.clientSdpId;
                        data.push({
                            sdp_id: thisRow.clientSdpId,
                            source: "ANY",
                            service_list: thisRow.service_id.toString(),
                            spa_encryption_key_base64: thisRow.encrypt_key,
                            spa_hmac_key_base64: thisRow.hmac_key
                        });
                    } else {
                        data[dataIdx].service_list += ", " + thisRow.service_id.toString();
                    }
    
                    dataIdx = data.length - 1;
    
                    // if this is the last data row or the next is a different gateway
                    if( (rowIdx + 1) == rows.length || 
                        rows[rowIdx + 1].gatewaySdpId != currentGatewaySdpId ) {
                        
                        // send off this gateway's data
                        if(config.debug) {
                            console.log("Access refresh data to send to "+currentGatewaySdpId+": \n", data);
                        }
                        
                        console.log("Sending access_refresh message to SDP ID " + currentGatewaySdpId);
                
                        writeToSocket(gatewaySocket,
                            JSON.stringify({
                                action: 'access_refresh',
                                data
                            }),
                            false
                        );
                        
                    } // END IF LAST ROW FOR THIS GATE
    
                } // END QUERY DATA FOR LOOP
                            
            } // END QUERY CALLBACK FUNCTION
    
        );  // END QUERY DEFINITION
            
    }  // END ELSE (i.e. NOT allowLegacyAccessRequests)
    
}  // END FUNCTION sendAllGatewaysAccessRefresh 



function sdpQueryException(sdpId, entries) {
    this.name = "SdpQueryException";
    this.message = "SDP ID " + sdpId + " query returned " + entries + " entries";
}

function sdpConfigException(configName, correctiveMessage) {
    this.name = "SdpConfigException";
    this.message = "Invalid entry for " + configName + "\n" + correctiveMessage;
}

