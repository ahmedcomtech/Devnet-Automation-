
import json
import pycurl
from io import BytesIO
import certifi
import paramiko
import netaddr
from tqdm import tqdm 
import time
import stdiomask
#import logging
#logging.basicConfig(level=logging.DEBUG)
print("------------------------------------")
print("Done by Ahmed Labeb for personal use")
print("+++++++++++++++++++++++++++++++++++++")
print("Used for mikrotik devices only..")
print("------------------------------------")
print("                                       ")
print("Use ripe for ASN number information ")
ASN = input("Please Enter ASN:    ")
router = (str(input("Router IP address:   ")))
username = input ("Router Username:   ")
password = stdiomask.getpass(prompt="Password: " , mask="X")
last_resort = input("Gateway for ASN routing:   ")
port = 22

heeaders = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/33.0.1750.117 Safari/537.36"}
link = ("https://stat.ripe.net/data/ris-prefixes/data.json?resource={}&list_prefixes=true").format(ASN)

#print (link)
print ("------------------------------")
b_obj = BytesIO()
crl = pycurl.Curl()

# Set URL value
crl.setopt(crl.URL, link)
crl.setopt(pycurl.CAINFO, certifi.where())
# Write bytes that are utf-8 encoded
crl.setopt(crl.WRITEDATA, b_obj)

# Perform a file transfer
crl.perform()

# End curl session
crl.close()

# Get the content stored in the BytesIO object (in byte characters)
get_body = b_obj.getvalue()
Data = get_body.decode('utf8')
# Decode the bytes stored in get_body to HTML and print the result
#print('Output of GET request:\n%s' % get_body.decode('utf8'))
#pprint (Data)
data = json.loads(Data)
#print (data)
#print (" ASN{} Originating below V4 Prefixes:".format(ASN))
#print (data['data']['prefixes']['v4']['originating'])
originatingv4 = (data['data']['prefixes']['v4']['originating'])
#print ("********************************************************")
#print (" ASN{} Transitting below V4 Prefixes:".format(ASN))
#print (data['data']['prefixes']['v4']['transiting'])
#print ("********************************************************")
#print (" ASN{} Originating below V6 Prefixes:".format(ASN))
#print (data['data']['prefixes']['v6']['originating'])
#print ("********************************************************")
#print (" ASN{} Transitting below V6 Prefixes:".format(ASN))
#print (data['data']['prefixes']['v6']['transiting'])
#print ("********************************************************")
for x in tqdm(range(len(originatingv4)), desc="Loading..."):
    time.sleep(0.3)
#Connecting to Router
client = paramiko.SSHClient()
client.load_system_host_keys()
client.set_missing_host_key_policy(paramiko.WarningPolicy)
client.connect(router, port=port, username=username, password=password)
#Adding addresses to Mikrotik firewall address list with ASN as a name50710
i = 0
list_of_cidrs=[]
for z in tqdm(range(len(originatingv4)), desc="Preparing Prefixes..."):
    time.sleep(0.3)
print("Please wait proccess may take time dont end or skip..just wait.  ")
while i < len(originatingv4):
    address =originatingv4[i]
    lind = ("https://m.stat.ripe.net/data/address-space-hierarchy/data.json?resource={}").format(address)
    b_obj = BytesIO()
    crl = pycurl.Curl()
    crl.setopt(crl.URL, lind)
    crl.setopt(pycurl.CAINFO, certifi.where())
    crl.setopt(crl.WRITEDATA, b_obj)
    crl.perform()
    crl.close()
    get_body = b_obj.getvalue()
    Datd = get_body.decode('utf8')
    datdd = json.loads(Datd)
    netnum = (datdd['data']['less_specific'][0]['inetnum'])
    #print (type(netnum))
    #print(netnum)
    tempduallist = netnum.split(sep='-')
    #print(tempduallist)
    startip = tempduallist[0]
    endip = tempduallist[1]
    cidr = netaddr.iprange_to_cidrs(startip, endip)
    #print(i,"     ",cidr[0])
    list_of_cidrs.append(cidr[0])
    i = i+1
list_of_cidrs = list(set(list_of_cidrs))
for y in tqdm(range(len(list_of_cidrs)), desc="Applying routes..."):
    time.sleep(0.3)
#print (list_of_cidrs)
k=0
while k < len(list_of_cidrs):
    command = (("ip route add comment={} dst-address={} gateway={}")
               .format(ASN, list_of_cidrs[k], last_resort))
    stdin, stdout, stderr = client.exec_command(command)
    print(list_of_cidrs[k],'Added Successfuly')
    k=k+1
command1 = (("ip route remove [find where dst-address={} gateway={}]").format('0.0.0.0/0',last_resort))
stdin, stdout, stderr = client.exec_command(command1)
stdout.read(),
client.close()
print("Done")

