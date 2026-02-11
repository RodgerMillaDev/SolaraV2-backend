const pkg_info    = require("./package.json"),
      query       = require("./query.js"),
      request     = require("request"),
	  export_obj  = {};
	  	 
export_obj.check = function(obj, callback){
	var url = encodeURI("https://languagetool.org/api/v2/check" + query(obj));
	  request(url, function(error, response, body){
	   var output = JSON.parse(body);
	   callback(error, output);
	});
}

export_obj.showMistakes = function(obj, callback){
	var mistakes = [];
	obj.matches.forEach(function(mistake){
		mistakes.push(mistake.context.text.substr(mistake.context.offset, mistake.context.length));
	});
	callback(mistakes);
}

export_obj.bestSuggestion = function(obj, callback){
	var suggestions = [];
    obj.matches.forEach(function(match){
		suggestions.push({
			mistake: match.context.text.substr(match.context.offset, match.context.length), 
			bestSuggestion: match.replacements[0].value
		});
	});
	callback(suggestions);
}

export_obj.codes = function(callback){
	request("https://languagetool.org/api/v2/languages", function(error, response, body){
		var parsedBody = JSON.parse(body);
		callback(error, parsedBody);
	});
}
	  
export_obj.info = function(){
	console.log(pkg_info.name + " by: " + pkg_info.author);
	console.log("Current version: " + pkg_info.version);
	return console.log("Source code: " + pkg_info.repository.url);
}

module.exports = export_obj